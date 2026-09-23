// The assembled engine (00-build E11; api.ts Engine). The worker host (src/worker) and headless
// runs (headless.ts: C1, lesson assertions, pnpm perf) build day runs from here.
//
// Module order is part of determinism and is fixed by 00-build §4: shared, load (E6), router
// (E7), replica (E5), failure (E8), metrics (E9).

import type {
  AnalystId,
  DayCheckpoint,
  DayRunInput,
  Engine,
  SessionSummary,
  SimConfig,
} from './api.ts';
import {
  applySetChanges,
  createDayRunner,
  dayStartParams,
  partitionPatches,
  type CoreDayRun,
  type DayRunner,
  type EngineModule,
  type RunnerOptions,
} from './core/index.ts';
import { failureModule } from './failure/index.ts';
import { loadModule, sessionPlan } from './load/index.ts';
import { drawThinkMs } from './load/script.ts';
import { metricsModule } from './metrics/index.ts';
import { replicaModule } from './replica/index.ts';
import { Source, u01 } from './rng/index.ts';
import { routerModule } from './router/index.ts';
import { sharedModule } from './shared/index.ts';
import { dayOf, type SimMs } from './time.ts';

export { dayRollup, inFlightTransitions } from './metrics/index.ts';
export { sessionPlan } from './load/index.ts';

/** The engine modules in their required order. */
export const ENGINE_MODULES: readonly EngineModule[] = [
  sharedModule,
  loadModule,
  routerModule,
  replicaModule,
  failureModule,
  metricsModule,
];

/** The Engine contract, with the core's richer day runs (live state for rollups and detail). */
export interface AssembledEngine extends Engine, DayRunner {
  createDayRun(input: DayRunInput): CoreDayRun;
  restoreDayRun(input: DayRunInput, checkpoint: DayCheckpoint): CoreDayRun;
  sessionPlan(input: DayRunInput): SessionSummary[];
}

/** Builds the engine. Options are for tests (assertEveryEvent, trace). */
export function createEngine(options?: RunnerOptions): AssembledEngine {
  const runner = createDayRunner(ENGINE_MODULES, options);
  return {
    createDayRun: (input) => runner.createDayRun(input),
    restoreDayRun: (input, checkpoint) => runner.restoreDayRun(input, checkpoint),
    sessionPlan,
  };
}

export const engine: AssembledEngine = createEngine();

/**
 * Per-request storage (K28): full records ('all') for the 1-GPU and 2-replica presets; Server A
 * and B keep the tracked analyst's records and re-simulate detail on demand.
 */
export function detailFor(config: Pick<SimConfig, 'replicas'>): 'all' | 'tracked' {
  return config.replicas <= 2 ? 'all' : 'tracked';
}

/**
 * How a scenario picks its tracked analyst (structurally the same as protocol.ts
 * TrackedAnalystRule; the engine may not import from src/worker).
 */
export type TrackedRule =
  | { rule: 'fixed'; analyst: AnalystId }
  | { rule: 'spansMoment'; momentMs: SimMs; minTurnsAfter: number };

/**
 * Planned arrival times of a session's turns, from the same keyed think-time draws as E6's
 * sessionPlan (think time after turn N keyed on (day, session, N), with the median in effect at
 * the session's start). Returns null when the result doesn't end at plannedEndMs, e.g. an extra
 * request or a think-time median changed in a way this doesn't model.
 */
export function plannedTurnTimes(
  input: DayRunInput,
  s: SessionSummary,
  medianAtStart: number,
): number[] | null {
  if (s.turns < 1) return [];
  const times = [s.startMs];
  let t = s.startMs;
  for (let turn = 1; turn < s.turns; turn++) {
    const think = drawThinkMs(
      input.config.seed,
      input.day,
      s.session,
      turn,
      medianAtStart,
      input.config.thinkTimeShape,
    );
    t = Math.max(t + think, t);
    times.push(t);
  }
  return t === s.plannedEndMs ? times : null;
}

/** thinkTimeMedianMs in effect at each time of day, from the day-start params and in-day patches. */
function medianAt(input: DayRunInput): (atMs: SimMs) => number {
  const start = dayStartParams(input);
  const steps: { atMs: SimMs; median: number }[] = [];
  const params = { ...start };
  for (const p of partitionPatches(input.patches, input.day).inDay) {
    if (p.kind !== 'set') continue;
    applySetChanges(params, p.changes);
    steps.push({ atMs: p.atMs, median: params.thinkTimeMedianMs });
  }
  return (atMs) => {
    let m = start.thinkTimeMedianMs;
    for (const s of steps) if (s.atMs <= atMs) m = s.median;
    return m;
  };
}

/** Turns strictly after momentMs: exact from the keyed draws, else spread evenly over the span. */
function turnsAfter(
  input: DayRunInput,
  s: SessionSummary,
  median: number,
  momentMs: SimMs,
): number {
  const times = plannedTurnTimes(input, s, median);
  if (times) return times.filter((t) => t > momentMs).length;
  if (s.turns <= 1) return s.startMs > momentMs ? 1 : 0;
  const step = (s.plannedEndMs - s.startMs) / (s.turns - 1);
  let n = 0;
  for (let i = 0; i < s.turns; i++) if (s.startMs + i * step > momentMs) n++;
  return n;
}

/**
 * The tracked analyst for a scenario's rule (protocol.ts TrackedAnalystRule; 05 §5).
 *
 * 'spansMoment': among the moment day's planned sessions whose span [startMs, plannedEndMs]
 * covers the moment with at least minTurnsAfter turns after it, the one with the smallest keyed
 * draw u01(seed, Source.trackedAnalyst, day, session). If none qualifies, the spanning session
 * with the most turns after the moment wins (same tie-break); failing that, the first session to
 * start after the moment; failing that, null. `plan` is sessionPlan(input) for the moment's day.
 *
 * `input` supplies config, calibration, and patches; its day is ignored.
 */
export function pickTrackedAnalyst(
  rule: TrackedRule,
  input: Omit<DayRunInput, 'day'> & { day?: DayRunInput['day'] },
  plan?: readonly SessionSummary[],
): AnalystId | null {
  if (rule.rule === 'fixed') return rule.analyst;
  const day = dayOf(rule.momentMs);
  const dayInput: DayRunInput = { ...input, day } as DayRunInput;
  const sessions = plan ?? sessionPlan(dayInput);
  const median = medianAt(dayInput);
  const moment = rule.momentMs;
  const key = (s: SessionSummary) => u01(input.config.seed, Source.trackedAnalyst, day, s.session);
  let best: { after: number; key: number; analyst: AnalystId } | null = null;
  for (const s of sessions) {
    if (!(s.startMs <= moment && moment <= s.plannedEndMs)) continue;
    const after = Math.min(turnsAfter(dayInput, s, median(s.startMs), moment), rule.minTurnsAfter);
    const k = key(s);
    if (!best || after > best.after || (after === best.after && k < best.key)) {
      best = { after, key: k, analyst: s.analyst };
    }
  }
  if (best) return best.analyst;
  let next: SessionSummary | null = null;
  for (const s of sessions) if (s.startMs > moment && (!next || s.startMs < next.startMs)) next = s;
  return next ? next.analyst : null;
}
