// A fixture-backed stand-in for the engine worker (00-build U2). It speaks the worker protocol with
// makeFixtureChunk data: it computes the focused day first in chunks, then the rest of the week,
// honours runId, revision, and the fork cut rule, and replies asynchronously in order.
// The data ignores parameter patches (it is synthetic); crash events do show as a crash.

import type { AnalystId, Patch, SimConfig } from '../engine/api.ts';
import {
  allocHistogramBlock,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  type RequestBlock,
  type ResultChunk,
  type TransitionBlock,
} from '../engine/results.ts';
import { DAY_MS, WEEK_DAYS, dayOf, type DayIndex, type SimMs } from '../engine/time.ts';
import {
  FIXTURE_BUCKET_MS,
  FIXTURE_HIST_BUCKET_MS,
  FIXTURE_TRACKED_ANALYST,
  makeFixtureChunk,
} from '../fixtures/chunks.ts';
import type { FixtureOptions } from '../fixtures/synthetic.ts';
import type {
  ComputedRange,
  MainToWorker,
  TrackedAnalystRule,
  WorkerScenario,
  WorkerToMain,
} from '../worker/protocol.ts';
import { concatBlocks, fakeRollup, setAnalyst } from './fake-blocks.ts';
import { cutMsFor } from './forks.ts';
import { normalizeRanges } from './ranges.ts';
import type { EngineTransport } from './transport.ts';

export interface FakeTransportOptions {
  /** How the fake defers work and replies. Default: a macrotask, like a real worker. */
  schedule?: (task: () => void) => void;
  /** Simulated time per chunk; a multiple of FIXTURE_HIST_BUCKET_MS. Default 15 minutes. */
  chunkMs?: number;
  /** Chunks computed per scheduled step. Default 1. */
  chunksPerStep?: number;
  /** structuredClone incoming messages, as postMessage would. Default true. */
  clone?: boolean;
}

export interface FakeTransport extends EngineTransport {
  /** Every message the fake received, in order (after cloning). */
  readonly received: readonly MainToWorker[];
  /** Delivers an arbitrary worker message, after anything already queued. */
  emit(msg: WorkerToMain): void;
  readonly terminated: boolean;
}

interface TrackedPiece {
  requests: RequestBlock;
  transitions: TransitionBlock;
}

interface Run {
  runId: number;
  revision: number;
  config: SimConfig;
  patches: Patch[];
  tracked: AnalystId | null;
  /** Per day: computed up to this time. */
  progress: SimMs[];
  /** Days still to compute, highest priority first. */
  order: DayIndex[];
  trackedPieces: TrackedPiece[][];
}

function initialTracked(rule: TrackedAnalystRule): AnalystId {
  return rule.rule === 'fixed' ? rule.analyst : FIXTURE_TRACKED_ANALYST;
}

const defaultSchedule = (task: () => void) => {
  setTimeout(task, 0);
};

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const schedule = options.schedule ?? defaultSchedule;
  const chunkMs = options.chunkMs ?? 15 * 60_000;
  const chunksPerStep = options.chunksPerStep ?? 1;
  const clone = options.clone ?? true;
  if (chunkMs <= 0 || chunkMs % FIXTURE_HIST_BUCKET_MS !== 0) {
    throw new RangeError(`chunkMs must be a positive multiple of ${FIXTURE_HIST_BUCKET_MS}`);
  }

  const handlers = new Set<(msg: WorkerToMain) => void>();
  const received: MainToWorker[] = [];
  let scenario: WorkerScenario | null = null;
  let run: Run | null = null;
  let computeScheduled = false;
  let terminated = false;

  function deliver(msg: WorkerToMain) {
    schedule(() => {
      if (!terminated) for (const h of [...handlers]) h(msg);
    });
  }

  function fixtureOpts(r: Run, day: DayIndex): FixtureOptions {
    const crash = r.patches.find(
      (p) => p.kind === 'event' && p.event.type === 'crash' && dayOf(p.atMs) === day,
    );
    return crash?.kind === 'event' && crash.event.type === 'crash'
      ? { replicas: r.config.replicas, crash: { replica: crash.event.replica, atMs: crash.atMs } }
      : { replicas: r.config.replicas };
  }

  function computed(r: Run): ComputedRange[] {
    const ranges: ComputedRange[] = [];
    r.progress.forEach((p, d) => {
      if (p > d * DAY_MS) ranges.push({ fromMs: d * DAY_MS, toMs: p });
    });
    return normalizeRanges(ranges);
  }

  function prioritize(r: Run, day: DayIndex) {
    if (r.progress[day]! >= (day + 1) * DAY_MS) return;
    r.order = [day, ...r.order.filter((d) => d !== day)];
  }

  function kick() {
    if (computeScheduled || !run || run.order.length === 0) return;
    computeScheduled = true;
    schedule(step);
  }

  function step() {
    computeScheduled = false;
    if (terminated || !run) return;
    for (let i = 0; i < chunksPerStep && run.order.length > 0; i++) computeOne(run);
    kick();
  }

  function trackedOnly(r: Run, chunk: ResultChunk): ResultChunk {
    if (r.tracked === null) {
      return {
        ...chunk,
        requests: allocRequestBlock('tracked', 0),
        transitions: allocTransitionBlock('tracked', 0),
      };
    }
    setAnalyst(chunk.requests, r.tracked);
    setAnalyst(chunk.transitions, r.tracked);
    return chunk;
  }

  function computeOne(r: Run) {
    const day = r.order[0]!;
    const from = r.progress[day]!;
    const dayEnd = (day + 1) * DAY_MS;
    const to = Math.min(dayEnd, (Math.floor(from / chunkMs) + 1) * chunkMs);
    const raw = makeFixtureChunk(fixtureOpts(r, day), from, to);
    // Keep the fixture's tracked records even while nobody is tracked, so a later track has a trace.
    r.trackedPieces[day]!.push({ requests: raw.requests, transitions: raw.transitions });
    const chunk = trackedOnly(r, raw);
    r.progress[day] = to;
    deliver({ type: 'chunk', runId: r.runId, revision: r.revision, chunk });
    deliver({ type: 'progress', runId: r.runId, revision: r.revision, computed: computed(r) });
    if (to >= dayEnd) {
      r.order.shift();
      const rollup = fakeRollup(fixtureOpts(r, day), day);
      deliver({ type: 'dayComplete', runId: r.runId, revision: r.revision, day, rollup });
    }
  }

  function startRun(runId: number, s: WorkerScenario, focusMs: SimMs) {
    if (s.config.histBucketMs % FIXTURE_HIST_BUCKET_MS !== 0) {
      deliver({
        type: 'error',
        runId,
        message: `Fake engine needs histBucketMs to be a multiple of ${FIXTURE_HIST_BUCKET_MS}`,
      });
      return;
    }
    const focus = dayOf(focusMs);
    const days = [...Array(WEEK_DAYS).keys()] as DayIndex[];
    run = {
      runId,
      revision: 0,
      config: s.config,
      patches: [...s.baselinePatches],
      tracked: initialTracked(s.tracked),
      progress: days.map((d) => d * DAY_MS),
      order: [...days.filter((d) => d >= focus), ...days.filter((d) => d < focus)],
      trackedPieces: days.map(() => []),
    };
    deliver({
      type: 'ready',
      runId,
      trackedAnalyst: run.tracked,
      sessionsByDay: days.map(() => []),
    });
    kick();
  }

  function fork(r: Run, revision: number, patch: Patch) {
    if (revision <= r.revision) return;
    r.revision = revision;
    r.patches.push(patch);
    const day = dayOf(patch.atMs);
    const cutMs = cutMsFor(patch.atMs, r.config.histBucketMs);
    r.progress[day] = Math.min(r.progress[day]!, cutMs);
    r.trackedPieces[day] = r.trackedPieces[day]!.map((p) => ({
      requests: concatBlocks(p.requests, [p.requests], 'tracked', (b, i) => b.endMs[i]! < cutMs),
      transitions: concatBlocks(
        p.transitions,
        [p.transitions],
        'tracked',
        (b, i) => b.atMs[i]! < cutMs,
      ),
    }));
    if (patch.kind === 'set') {
      for (let d = day + 1; d < WEEK_DAYS; d++) {
        r.progress[d] = d * DAY_MS;
        r.trackedPieces[d] = [];
        if (!r.order.includes(d as DayIndex)) r.order.push(d as DayIndex);
      }
    }
    if (!r.order.includes(day)) r.order.push(day);
    prioritize(r, day);
    kick();
  }

  function traceChunk(r: Run, day: DayIndex, analyst: AnalystId): ResultChunk {
    const pieces = r.trackedPieces[day]!;
    const requests = concatBlocks(
      allocRequestBlock('tracked', 0),
      pieces.map((p) => p.requests),
      'tracked',
    );
    const transitions = concatBlocks(
      allocTransitionBlock('tracked', 0),
      pieces.map((p) => p.transitions),
      'tracked',
    );
    setAnalyst(requests, analyst);
    setAnalyst(transitions, analyst);
    const start = day * DAY_MS;
    const series = r.config.replicas + 1;
    return {
      day,
      fromMs: start,
      toMs: r.progress[day]!,
      replicas: r.config.replicas,
      scalars: allocScalarBlock(start, FIXTURE_BUCKET_MS, 0, series),
      histograms: allocHistogramBlock(start, FIXTURE_HIST_BUCKET_MS, 0, series),
      requests,
      transitions,
      replicaEvents: [],
    };
  }

  function detail(r: Run, requestTag: number, fromMs: SimMs, toMs: SimMs) {
    const day = dayOf(fromMs);
    const bucket = FIXTURE_HIST_BUCKET_MS;
    const from = Math.floor(fromMs / bucket) * bucket;
    const to = Math.max(
      from + bucket,
      Math.min((day + 1) * DAY_MS, Math.ceil(toMs / bucket) * bucket),
    );
    const chunk = makeFixtureChunk(fixtureOpts(r, day), from, to);
    chunk.requests.scope = 'all';
    chunk.transitions.scope = 'all';
    deliver({ type: 'detail', runId: r.runId, revision: r.revision, requestTag, chunk });
  }

  function handle(msg: MainToWorker) {
    if (terminated) return;
    received.push(msg);
    if (msg.type === 'init') {
      scenario = msg.scenario;
      startRun(msg.runId, msg.scenario, msg.focusMs);
      return;
    }
    if (msg.type === 'reset') {
      if (scenario) startRun(msg.runId, scenario, msg.focusMs);
      return;
    }
    const r = run;
    if (!r || msg.runId !== r.runId) return;
    switch (msg.type) {
      case 'focus':
        prioritize(r, dayOf(msg.atMs));
        kick();
        return;
      case 'fork':
        fork(r, msg.revision, msg.patch);
        return;
      case 'requestDetail':
        detail(r, msg.requestTag, msg.fromMs, msg.toMs);
        return;
      case 'track':
        r.tracked = msg.analyst;
        if (msg.analyst === null) return;
        for (let d = 0; d < WEEK_DAYS; d++) {
          if (r.progress[d]! <= d * DAY_MS) continue;
          const chunk = traceChunk(r, d as DayIndex, msg.analyst);
          deliver({
            type: 'trace',
            runId: r.runId,
            revision: r.revision,
            analyst: msg.analyst,
            day: d as DayIndex,
            chunk,
          });
        }
        return;
    }
  }

  return {
    postMessage(msg) {
      if (terminated) return;
      const copy = clone ? structuredClone(msg) : msg;
      schedule(() => handle(copy));
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    terminate() {
      terminated = true;
      handlers.clear();
    },
    emit: deliver,
    received,
    get terminated() {
      return terminated;
    },
  };
}
