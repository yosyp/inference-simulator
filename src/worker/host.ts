// The engine host (00-build E11; 04 §3; K11, K21, K28): speaks protocol.ts, computes days in
// chunks ahead of the playhead, and forks from checkpoints. It is plain code with an injected
// `post` and `schedule`, so it runs in Node tests; engine.worker.ts binds it to the worker.
//
// Scheduling. Work runs in slices of at most `sliceMs` wall time (at least one unit), then yields
// through `schedule`, so focus, fork, and reset are handled within one unit. A unit is one
// streamed chunk (≤ 5 simulated minutes) or one silent replay step of the same size, about
// 0.1 s at Server B's peak. Each unit re-picks the most urgent work:
//   1. detail requests, first come first served;
//   2. the focus day's stream (the playhead's day, from its morning: K21);
//   3. the prefetch day's stream (a lookahead focus with prefetch: protocol.ts);
//   4. the focus day's trace, after a track;
//   5. the focus day's missing 15-minute checkpoints (densify, S1 §6);
//   6. the other days' streams: later days first, then earlier ones;
//   7. the other days' traces, in the same order.
//
// A prefetch only reorders streams: the focus day keeps its 15-minute checkpoints, and the
// prefetch day streams with the other-day policy until a plain focus moves the playhead onto it.
//
// Ready. The tracked analyst is picked at init from the moment day's session plan alone, and 'ready'
// goes out at once, after init and after reset, before the first chunk.
//
// Forks follow the cut rule in protocol.ts: nothing before cutMs is sent again. Messages carry the
// current runId and revision; everything posted after a fork was computed under it.

import type { AnalystId, Patch, SessionSummary } from '../engine/api.ts';
import {
  detailFor,
  engine as defaultEngine,
  pickTrackedAnalyst,
  type AssembledEngine,
} from '../engine/index.ts';
import {
  WEEK_DAYS,
  WEEK_MS,
  dayOf,
  dayStartMs,
  type DayIndex,
  type SimMs,
} from '../engine/time.ts';
import { cutSlot, needsDensify, refocus, resetSlot, stepDay, stepDensify } from './days.ts';
import { createGrid, type GridOptions } from './grid.ts';
import { answerEmpty, requestDetail, stepDetail, stepTrace } from './jobs.ts';
import type { Calibration } from '../engine/calibration.ts';
import type { MainToWorker, WorkerScenario, WorkerToMain } from './protocol.ts';
import type { Schedule } from './scheduler.ts';
import { dayOrder, newRun, rebind, type Active, type Host, type Setup } from './state.ts';

export interface EngineHostOptions {
  post(msg: WorkerToMain, transfer: ArrayBuffer[]): void;
  schedule: Schedule;
  /** Wall clock for slicing. Default performance.now. */
  now?: () => number;
  /** Wall time per slice before yielding; at least one unit runs. Default 16 ms. */
  sliceMs?: number;
  /**
   * Byte budget for hourly checkpoints on days other than the focus day; the days nearest the
   * focus keep theirs. Default 16 MiB: every day of a 1–2 replica run, a few Server B hours.
   */
  checkpointBudgetBytes?: number;
  grid?: GridOptions;
  engine?: AssembledEngine;
}

export interface EngineHost {
  handle(msg: MainToWorker): void;
  /** Stops scheduling and drops all state. */
  dispose(): void;
}

/**
 * P4 (00-build §8) leaves about 250 MB for main thread plus worker after a 150 MB page baseline.
 * At Server B knee load the results store takes about 70 MB a week and the focus day's 15-minute
 * checkpoints about 145 MB (3.6 MB each with E4 as merged), so other days get what is left.
 */
export const DEFAULT_CHECKPOINT_BUDGET_BYTES = 16 * 1024 * 1024;

function clampWeek(ms: SimMs): SimMs {
  return Math.min(WEEK_MS - 1, Math.max(0, ms));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createEngineHost(options: EngineHostOptions): EngineHost {
  const now = options.now ?? (() => performance.now());
  const sliceMs = options.sliceMs ?? 16;
  let scheduled = false;
  let disposed = false;
  /** The day a prefetch focus asked for, until a plain focus, fork, or reset. */
  let prefetchDay: DayIndex | null = null;
  const h: Host = {
    engine: options.engine ?? defaultEngine,
    post: (msg, transfer = []) => {
      if (!disposed) options.post(msg, transfer);
    },
    budgetBytes: options.checkpointBudgetBytes ?? DEFAULT_CHECKPOINT_BUDGET_BYTES,
    setup: null,
    run: null,
  };

  function active(): Active | null {
    return h.setup && h.run && !h.run.failed ? (h as Active) : null;
  }

  function fail(runId: number, e: unknown): void {
    if (h.run && h.run.runId === runId) h.run.failed = true;
    h.post({ type: 'error', runId, message: message(e) });
  }

  // --- Work ---------------------------------------------------------------------------------

  function stepReady(a: Active): void {
    postReady(a);
  }

  function postReady(a: Active): void {
    a.run.readyAfterMs = null;
    h.post({ type: 'ready', runId: a.run.runId, trackedAnalyst: a.setup.initialTracked });
  }

  /** The most urgent unit of work, or null when everything is done. */
  function pick(a: Active): (() => void) | null {
    const r = a.run;
    if (r.readyAfterMs !== null) {
      const slot = r.days[dayOf(r.readyAfterMs)]!;
      if (slot.complete || slot.streamedToMs > r.readyAfterMs) return () => stepReady(a);
    }
    const job = r.details[0];
    if (job) return () => void (stepDetail(a, job) && r.details.shift());
    const order = dayOrder(r.focusDay);
    const traceFor = (d: DayIndex) => r.traces.find((t) => t.day === d);
    const f = r.days[r.focusDay]!;
    if (!f.complete) return () => stepDay(a, f);
    const p = prefetchDay === null ? null : r.days[prefetchDay]!;
    if (p && !p.complete) return () => stepDay(a, p);
    const ft = traceFor(r.focusDay);
    if (ft) return () => void (stepTrace(a, ft) && r.traces.splice(r.traces.indexOf(ft), 1));
    if (needsDensify(a, f)) return () => stepDensify(a, f);
    for (const d of order) {
      const slot = r.days[d]!;
      if (!slot.complete) return () => stepDay(a, slot);
    }
    for (const d of order) {
      const t = traceFor(d);
      if (t) return () => void (stepTrace(a, t) && r.traces.splice(r.traces.indexOf(t), 1));
    }
    return null;
  }

  function tick(): void {
    scheduled = false;
    const start = now();
    for (;;) {
      const a = active();
      if (!a || disposed) return;
      const work = pick(a);
      if (!work) return;
      try {
        work();
      } catch (e) {
        fail(a.run.runId, e);
        return;
      }
      if (now() - start >= sliceMs) break;
    }
    kick();
  }

  function kick(): void {
    if (scheduled || disposed || !active()) return;
    scheduled = true;
    options.schedule(tick);
  }

  // --- Messages -----------------------------------------------------------------------------

  function start(runId: number, focusMs: SimMs): void {
    const setup = h.setup!;
    const focus = clampWeek(focusMs);
    h.run = newRun(runId, setup, dayOf(focus), focus);
    prefetchDay = null;
    postReady(h as Active);
    kick();
  }

  function planOf(setup: Pick<Setup, 'scenario' | 'calibration'>, day: DayIndex): SessionSummary[] {
    return h.engine.sessionPlan({
      config: setup.scenario.config,
      calibration: setup.calibration,
      patches: setup.scenario.baselinePatches,
      day,
      trackedAnalyst: null,
      detail: 'tracked',
    });
  }

  function init(scenario: WorkerScenario, calibration: Calibration): Setup {
    const base = { config: scenario.config, calibration, patches: scenario.baselinePatches };
    const plans: (SessionSummary[] | null)[] = Array.from({ length: WEEK_DAYS }, () => null);
    const rule = scenario.tracked;
    let plan: SessionSummary[] | undefined;
    if (rule.rule === 'spansMoment') {
      const day = dayOf(rule.momentMs);
      plan = planOf({ scenario, calibration }, day);
    }
    return {
      scenario,
      calibration,
      detail: detailFor(scenario.config),
      grid: createGrid(scenario.config, options.grid),
      plans,
      initialTracked: pickTrackedAnalyst(
        rule,
        { ...base, trackedAnalyst: null, detail: 'tracked' },
        plan,
      ),
    };
  }

  function fork(a: Active, revision: number, patch: Patch): void {
    const r = a.run;
    if (!(revision > r.revision)) return;
    const day = dayOf(patch.atMs);
    const hb = a.setup.scenario.config.histBucketMs;
    const cutMs = Math.floor(patch.atMs / hb) * hb;
    const lasting = patch.kind === 'set';
    r.revision = revision;
    r.patches = [...r.patches, patch];
    const affects = (d: DayIndex, toMs: SimMs) =>
      (d === day && toMs > cutMs) || (lasting && d > day);
    // Detail windows the fork invalidates get an empty answer now; the main thread asks again.
    r.details = r.details.filter((job) => {
      if (!affects(job.day, job.toMs)) return true;
      answerEmpty(a, job);
      return false;
    });
    r.detailCache = null;
    // Traces: the fork's day now streams again from the cut with the tracked analyst.
    r.traces = r.traces.filter((t) => !(lasting && t.day > day));
    for (const t of r.traces) if (t.day === day) t.toMs = Math.min(t.toMs, cutMs);
    r.traces = r.traces.filter((t) => t.toMs > dayStartMs(t.day));
    cutSlot(a, r.days[day]!, cutMs);
    if (lasting) for (let d = day + 1; d < WEEK_DAYS; d++) r.days[d] = resetSlot(a, r.days[d]!);
    // The main thread treats the fork's day as the worker's focus from now on (U2 store.fork).
    prefetchDay = null;
    refocus(a, day, patch.atMs);
  }

  function track(a: Active, analyst: AnalystId | null): void {
    const r = a.run;
    if (analyst === r.tracked) return;
    r.tracked = analyst;
    r.traces = [];
    r.detailCache = null;
    for (const slot of r.days) {
      if (slot.run) slot.run = rebind(a, slot.run);
      if (analyst === null || a.setup.detail === 'all') continue;
      if (slot.streamedToMs > dayStartMs(slot.day)) {
        r.traces.push({ day: slot.day, analyst, toMs: slot.streamedToMs, run: null, parts: [] });
      }
    }
  }

  function handle(msg: MainToWorker): void {
    if (disposed) return;
    try {
      if (msg.type === 'init') {
        h.run = null;
        h.setup = null;
        h.setup = init(msg.scenario, msg.calibration);
        start(msg.runId, msg.focusMs);
        return;
      }
      if (msg.type === 'reset') {
        if (!h.setup) throw new Error('reset before init');
        start(msg.runId, msg.focusMs);
        return;
      }
      const a = active();
      if (!a || msg.runId !== a.run.runId) return;
      switch (msg.type) {
        case 'focus': {
          const t = clampWeek(msg.atMs);
          const day = dayOf(t);
          if (msg.prefetch) {
            prefetchDay = day === a.run.focusDay ? null : day;
          } else {
            prefetchDay = null;
            refocus(a, day, t);
          }
          break;
        }
        case 'fork':
          fork(a, msg.revision, msg.patch);
          break;
        case 'requestDetail':
          requestDetail(a, msg.requestTag, msg.fromMs, msg.toMs);
          break;
        case 'track':
          track(a, msg.analyst);
          break;
      }
      kick();
    } catch (e) {
      fail(msg.runId, e);
    }
  }

  return {
    handle,
    dispose() {
      disposed = true;
      h.setup = null;
      h.run = null;
    },
  };
}
