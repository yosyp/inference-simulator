// Test support for the engine host: a manual scheduler, a cloning `post`, small scenarios, and a
// main-thread view of the messages (the fork cut rule applied) to compare runs exactly.

import type { Patch, SimConfig } from '../engine/api.ts';
import type { Calibration } from '../engine/calibration.ts';
import { digestState } from '../engine/core/index.ts';
import { HISTOGRAM_METRICS } from '../engine/histogram.ts';
import {
  SCALAR_METRIC_NAMES,
  type RequestBlock,
  type ResultChunk,
  type RollupRow,
  type TransitionBlock,
} from '../engine/results.ts';
import { DAY_MS, HOUR_MS, WEEK_DAYS, dayOf, type DayIndex, type SimMs } from '../engine/time.ts';
import { createEngineHost, type EngineHost, type EngineHostOptions } from './host.ts';
import type { MainToWorker, TrackedAnalystRule, WorkerScenario, WorkerToMain } from './protocol.ts';

export interface TestHost {
  host: EngineHost;
  /** Everything posted, cloned with its transfer list as postMessage would. */
  out: WorkerToMain[];
  /** Delivers a message now, between scheduled tasks, as a worker message event would. */
  send(msg: MainToWorker): void;
  /** Runs scheduled tasks until none is left (or the limit); returns how many ran. */
  runAll(limit?: number): number;
  /** Runs tasks until done() holds; throws if the queue empties first. */
  runUntil(done: () => boolean, limit?: number): void;
  readonly pending: number;
}

export function createTestHost(options: Partial<EngineHostOptions> = {}): TestHost {
  const tasks: (() => void)[] = [];
  const out: WorkerToMain[] = [];
  const host = createEngineHost({
    post: (msg, transfer) => out.push(structuredClone(msg, { transfer })),
    schedule: (task) => tasks.push(task),
    now: () => 0,
    sliceMs: 0,
    ...options,
  });
  const runNext = () => {
    const t = tasks.shift();
    if (!t) return false;
    t();
    return true;
  };
  return {
    host,
    out,
    send: (msg) => host.handle(structuredClone(msg)),
    runAll(limit = 1_000_000) {
      let n = 0;
      while (n < limit && runNext()) n++;
      return n;
    },
    runUntil(done, limit = 1_000_000) {
      for (let n = 0; !done(); n++) {
        if (n >= limit || !runNext()) throw new Error('runUntil: condition never held');
      }
    },
    get pending() {
      return tasks.length;
    },
  };
}

/** A small scenario: fixture-like load, `analysts` per replica, shift 07:00–17:00. */
export function smallConfig(replicas: number, analysts = 50, seed = 7): SimConfig {
  return {
    seed,
    replicas,
    analystsPerReplica: analysts,
    shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
    diurnal: {
      knots: [
        [6.5 * HOUR_MS, 0],
        [7 * HOUR_MS, 0.3],
        [10.5 * HOUR_MS, 1],
        [12 * HOUR_MS, 0.7],
        [14.5 * HOUR_MS, 0.9],
        [17 * HOUR_MS, 0],
      ],
      dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
    },
    sessionsPerAnalystPerDay: 3,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 64,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 800,
      turnsPerSessionMean: 4,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 90_000,
      timeoutToFirstTokenMs: 60_000,
      retryPolicy: 'exponential',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 3,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

export function scenarioOf(
  config: SimConfig,
  baselinePatches: Patch[] = [],
  tracked: TrackedAnalystRule = { rule: 'fixed', analyst: 3 },
): WorkerScenario {
  return { config, baselinePatches, tracked };
}

export function initMsg(
  scenario: WorkerScenario,
  calibration: Calibration,
  focusMs: SimMs,
  runId = 1,
): MainToWorker {
  return { type: 'init', runId, scenario, calibration, focusMs };
}

// --- A main-thread view: what the results store would hold, in comparable form ---------------

export interface DayView {
  /** Scalar bucket start → every metric's values for every series. */
  scalars: Map<number, number[]>;
  /** Histogram bucket start → [metric, cell, bin, count] rows. */
  hists: Map<number, number[]>;
  /** Request records as rows, in arrival order of the stream. */
  requests: number[][];
  /** Transitions as rows [atMs, request, analyst, replica, state], in stream order. */
  transitions: number[][];
  rollup: RollupRow[] | null;
}

export type WeekView = DayView[];

export function emptyWeek(): WeekView {
  return Array.from({ length: WEEK_DAYS }, () => ({
    scalars: new Map(),
    hists: new Map(),
    requests: [],
    transitions: [],
    rollup: null,
  }));
}

export function requestRows(b: RequestBlock): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < b.count; i++) {
    rows.push([
      b.id[i]!,
      b.session[i]!,
      b.analyst[i]!,
      b.turn[i]!,
      b.attempt[i]!,
      b.replica[i]!,
      b.prevReplica[i]!,
      b.arriveMs[i]!,
      b.dispatchMs[i]!,
      b.firstTokenMs[i]!,
      b.endMs[i]!,
      b.promptTokens[i]!,
      b.cachedTokens[i]!,
      b.outputTokens[i]!,
      b.preemptions[i]!,
      b.outcome[i]!,
    ]);
  }
  return rows;
}

export function transitionRows(b: TransitionBlock): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < b.count; i++) {
    rows.push([b.atMs[i]!, b.request[i]!, b.analyst[i]!, b.replica[i]!, b.state[i]!]);
  }
  return rows;
}

/** Adds a main chunk to the view. */
export function addChunk(view: WeekView, chunk: ResultChunk): void {
  const dv = view[chunk.day]!;
  const s = chunk.scalars;
  const cells = s.series;
  for (let i = 0; i < s.count; i++) {
    const values: number[] = [];
    for (const m of SCALAR_METRIC_NAMES) {
      for (let c = 0; c < cells; c++) values.push(s.data[m][i * cells + c]!);
    }
    dv.scalars.set(s.startMs + i * s.bucketMs, values);
  }
  const h = chunk.histograms;
  for (let i = 0; i < h.count; i++) {
    const rows: number[] = [];
    HISTOGRAM_METRICS.forEach((m, mi) => {
      const sp = h.data[m];
      for (let c = 0; c < h.series; c++) {
        const cell = i * h.series + c;
        for (let k = sp.offsets[cell]!; k < sp.offsets[cell + 1]!; k++) {
          rows.push(mi, c, sp.bins[k]!, sp.counts[k]!);
        }
      }
    });
    dv.hists.set(h.startMs + i * h.bucketMs, rows);
  }
  dv.requests.push(...requestRows(chunk.requests));
  dv.transitions.push(...transitionRows(chunk.transitions));
}

/** The fork cut rule (protocol.ts) applied to the view. */
export function cutView(view: WeekView, day: DayIndex, cutMs: SimMs, lasting: boolean): void {
  for (let d = day; d < WEEK_DAYS; d++) {
    if (d > day && !lasting) break;
    const dv = view[d]!;
    const from = d === day ? cutMs : d * DAY_MS;
    for (const t of [...dv.scalars.keys()]) if (t >= from) dv.scalars.delete(t);
    for (const t of [...dv.hists.keys()]) if (t >= from) dv.hists.delete(t);
    dv.requests = dv.requests.filter((r) => r[10]! < from);
    dv.transitions = dv.transitions.filter((r) => r[0]! < from);
    dv.rollup = null;
  }
}

/** Applies the messages of `runId` in order: chunks and rollups. */
export function applyMessages(view: WeekView, messages: readonly WorkerToMain[], runId = 1): void {
  for (const m of messages) {
    if (m.runId !== runId) continue;
    if (m.type === 'chunk') addChunk(view, m.chunk);
    else if (m.type === 'dayComplete') view[m.day]!.rollup = m.rollup;
  }
}

/**
 * A comparable form of the view: per day and component, a digest plus a count, so a mismatch
 * names the day and the component without diffing millions of numbers.
 */
export function canonical(view: WeekView): unknown {
  return view.map((dv) => {
    const scalars = [...dv.scalars.entries()].sort((a, b) => a[0] - b[0]);
    const hists = [...dv.hists.entries()].sort((a, b) => a[0] - b[0]);
    const requests = [...dv.requests].sort((a, b) => a[10]! - b[10]! || a[0]! - b[0]!);
    const transitions = dv.transitions
      .map((r, i) => [r, i] as const)
      .sort((a, b) => a[0][0]! - b[0][0]! || a[1] - b[1])
      .map(([r]) => r);
    return {
      scalars: [scalars.length, digestState(scalars)],
      hists: [hists.length, digestState(hists)],
      requests: [requests.length, digestState(requests)],
      transitions: [transitions.length, digestState(transitions)],
      rollup: dv.rollup,
    };
  });
}

/** The day a message's data belongs to, for ordering checks. */
export function messageDay(m: WorkerToMain): DayIndex | null {
  if (m.type === 'chunk' || m.type === 'detail' || m.type === 'trace') return m.chunk.day;
  if (m.type === 'dayComplete') return m.day;
  return null;
}

export { dayOf };
