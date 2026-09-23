// The metrics slice (00-build E9; 02 §11). It holds only what hasn't been emitted yet, so
// checkpoints stay small (K7): the open buckets' accumulators, the buckets and records completed
// since the last produceChunk, the cumulative meter values at the last bucket boundary (for
// diffing), and a few per-day totals for the High-side rollup (01 §8).

import { createLevel, type Level } from '../core/level.ts';
import type { DayState } from '../core/types.ts';
import type { HistogramMetric } from '../histogram.ts';
import {
  SCALAR_METRIC_NAMES,
  allocDenseHistograms,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  type ReplicaEvent,
  type RequestBlock,
  type ScalarBlock,
  type ScalarMetric,
  type TransitionBlock,
} from '../results.ts';
import { REPLICA_COUNTERS, type ReplicaMeters } from '../shared/meters.ts';
import type { SharedSlice } from '../shared/module.ts';
import { DAY_MS, type SimMs } from '../time.ts';

export interface MetricsSlice {
  replicas: number;
  /** Start of the open scalar bucket; always state.core.closedToMs. */
  bucketStartMs: SimMs;
  /** Start of the open histogram bucket: the last multiple of histBucketMs <= bucketStartMs. */
  histStartMs: SimMs;
  /** Open scalar bucket, [metric][series] (index METRIC_INDEX[m] * series + s). Float64 until emitted. */
  open: Float64Array;
  /** Open histogram bucket per metric, [series][bin]. */
  openHist: Record<HistogramMetric, Uint32Array>;

  /** Scalar buckets completed since the last produceChunk; `count` used, arrays sized for capacity. */
  scalars: ScalarBlock;
  /** Histogram buckets completed since the last produceChunk, dense until emitted (K29). */
  hists: PendingHists;
  /** Records and transitions since the last produceChunk; `count` used. `scope` is set on emit. */
  requests: RequestBlock;
  transitions: TransitionBlock;
  replicaEvents: ReplicaEvent[];
  /** toMs of the last produceChunk; nothing pending is older. */
  emittedToMs: SimMs;

  /** Cumulative ReplicaMeters counters at the last boundary, [counter][replica]. */
  prevCounters: Float64Array;
  prevAbandoned: number;

  /** 1 while a replica is Ready (REPLICA_STATE.ready). Every replica is Ready at the day's start. */
  ready: Uint8Array;
  readyCount: Level;
  /** Fleet kvUsedFrac: ∫ kvUsed dt and time while Ready, this bucket, per replica. */
  readyKvArea: Float64Array;
  readyMs: Float64Array;
  /** Where the current Ready stretch began in this bucket: time and the kvUsed level's area then. */
  markMs: Float64Array;
  markArea: Float64Array;

  /** Day totals, for conservation checks: arrived, then ended by outcome. */
  day: DayTotals;
  /** Rollup totals per replica. */
  served: Float64Array;
  servedE2eMs: Float64Array;
  /** busyMs that fell inside [shiftStartMs, shiftEndMs), pro-rated per bucket. */
  busyInShiftMs: Float64Array;
  shiftStartMs: SimMs;
  shiftEndMs: SimMs;
}

/** Dense histogram buckets in allocDenseHistograms layout; `count` used, arrays sized for capacity. */
export interface PendingHists {
  startMs: SimMs;
  count: number;
  series: number;
  dense: Record<HistogramMetric, Uint32Array>;
}

export function emptyPendingHists(startMs: SimMs, series: number): PendingHists {
  return { startMs, count: 0, series, dense: allocDenseHistograms(0, series) };
}

export interface DayTotals {
  arrived: number;
  finished: number;
  rejected: number;
  timedOut: number;
  failed: number;
}

declare module '../core/types.ts' {
  interface DayState {
    metrics: MetricsSlice;
  }
}

/** Position of each scalar metric in `open`. Code, not state. */
export const METRIC_INDEX = Object.fromEntries(SCALAR_METRIC_NAMES.map((m, i) => [m, i])) as Record<
  ScalarMetric,
  number
>;
export const METRIC_COUNT = SCALAR_METRIC_NAMES.length;

/** ∫ value dt over the level's open interval, up to atMs, without changing the level. */
export function levelAreaAt(level: Level, atMs: SimMs): number {
  return level.area + level.value * (atMs - level.sinceMs);
}

export function sharedOf(state: DayState): SharedSlice {
  const shared = (state as { shared?: SharedSlice }).shared;
  if (!shared) throw new Error('metrics: the shared module must come first in the module list');
  return shared;
}

/** Pending buffers emptied, starting at the open buckets. Called at init and after every emit. */
export function resetPending(s: MetricsSlice, bucketMs: number, toMs: SimMs): void {
  const series = s.replicas + 1;
  s.scalars = allocScalarBlock(s.bucketStartMs, bucketMs, 0, series);
  s.hists = emptyPendingHists(s.histStartMs, series);
  s.requests = allocRequestBlock('all', 0);
  s.transitions = allocTransitionBlock('all', 0);
  s.replicaEvents = [];
  s.emittedToMs = toMs;
}

function snapshotCounters(meters: ReplicaMeters, replicas: number): Float64Array {
  const out = new Float64Array(REPLICA_COUNTERS.length * replicas);
  REPLICA_COUNTERS.forEach((c, k) => out.set(meters[c].subarray(0, replicas), k * replicas));
  return out;
}

export function createMetricsSlice(
  state: DayState,
  nowMs: SimMs,
  input: {
    replicas: number;
    bucketMs: number;
    histBucketMs: number;
    shift: { startMs: number; endMs: number };
  },
): MetricsSlice {
  const { replicas, bucketMs, histBucketMs, shift } = input;
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 127) {
    throw new RangeError(`metrics: ${replicas} replicas; records hold replica ids as int8`);
  }
  const meters = sharedOf(state).meters;
  const series = replicas + 1;
  const clampDay = (t: number) => nowMs + Math.min(DAY_MS, Math.max(0, t));
  const shiftStartMs = clampDay(shift.startMs);
  const kv = meters.replica.kvUsed;
  const histStartMs = Math.floor(nowMs / histBucketMs) * histBucketMs;
  return {
    replicas,
    bucketStartMs: nowMs,
    histStartMs,
    open: new Float64Array(METRIC_COUNT * series),
    openHist: allocDenseHistograms(1, series),
    scalars: allocScalarBlock(nowMs, bucketMs, 0, series),
    hists: emptyPendingHists(histStartMs, series),
    requests: allocRequestBlock('all', 0),
    transitions: allocTransitionBlock('all', 0),
    replicaEvents: [],
    emittedToMs: nowMs,
    prevCounters: snapshotCounters(meters.replica, replicas),
    prevAbandoned: meters.fleet.abandonedSessions,
    ready: new Uint8Array(replicas).fill(1),
    readyCount: createLevel(nowMs, replicas),
    readyKvArea: new Float64Array(replicas),
    readyMs: new Float64Array(replicas),
    markMs: new Float64Array(replicas).fill(nowMs),
    markArea: Float64Array.from({ length: replicas }, (_, r) => levelAreaAt(kv[r]!, nowMs)),
    day: { arrived: 0, finished: 0, rejected: 0, timedOut: 0, failed: 0 },
    served: new Float64Array(replicas),
    servedE2eMs: new Float64Array(replicas),
    busyInShiftMs: new Float64Array(replicas),
    shiftStartMs,
    shiftEndMs: Math.max(shiftStartMs, clampDay(shift.endMs)),
  };
}
