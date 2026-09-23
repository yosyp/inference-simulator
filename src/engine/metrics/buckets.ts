// Bucket ends and chunk production (02 §11; results.ts). At a scalar boundary the open bucket is
// finished from the meters (counter diffs, level means) and moved into the pending block; at a
// histogram boundary the open histograms move too. produceChunk hands the pending blocks and
// records out as exact-size typed arrays, histograms in sparse form (K29), and empties the slice.
//
// Fleet series (results.ts): sums add across replicas. Level means (running, waiting,
// outstanding) are summed across replicas. kvUsedFrac is the mean over Ready replica-time in the
// bucket: Σ_r ∫ kvUsed_r dt while Ready ÷ Σ_r time Ready (0 if no replica was Ready). kvUsedFracMax
// is the max over replicas. readyReplicas is the time-weighted Ready count.

import { takeLevelMean } from '../core/level.ts';
import type { ChunkSpan, Ctx, DayState } from '../core/types.ts';
import { SCALAR_METRIC_NAMES, type ResultChunk } from '../results.ts';
import { REPLICA_COUNTERS } from '../shared/meters.ts';
import type { SimMs } from '../time.ts';
import {
  exactRequests,
  exactScalars,
  exactTransitions,
  pushHistBucket,
  pushScalarBucket,
  sparseHists,
} from './pending.ts';
import { METRIC_INDEX as MI, levelAreaAt, resetPending } from './slice.ts';

const COUNTER_METRIC = REPLICA_COUNTERS.map((c) => MI[c]);
const BUSY = REPLICA_COUNTERS.indexOf('busyMs');
const LEVELS = ['running', 'waiting', 'outstanding'] as const;
const LEVEL_METRIC = LEVELS.map((l) => MI[l]);

export function closeBucket(state: DayState, boundaryMs: SimMs, ctx: Ctx): void {
  const s = state.metrics;
  const { bucketMs, histBucketMs } = ctx.input.config;
  const startMs = s.bucketStartMs;
  if (boundaryMs !== startMs + bucketMs) {
    throw new Error(`metrics: bucket end ${boundaryMs} does not close [${startMs}, +${bucketMs})`);
  }
  const R = s.replicas;
  const S = R + 1;
  const o = s.open;
  const meters = state.shared.meters;
  const rm = meters.replica;

  // Counter diffs. busyMs inside the shift also feeds the rollup, pro-rated by overlap.
  const overlap =
    Math.max(0, Math.min(boundaryMs, s.shiftEndMs) - Math.max(startMs, s.shiftStartMs)) / bucketMs;
  for (let k = 0; k < REPLICA_COUNTERS.length; k++) {
    const cum = rm[REPLICA_COUNTERS[k]!];
    const base = COUNTER_METRIC[k]! * S;
    let fleet = 0;
    for (let r = 0; r < R; r++) {
      const v = cum[r]! - s.prevCounters[k * R + r]!;
      s.prevCounters[k * R + r] = cum[r]!;
      o[base + r + 1] = v;
      fleet += v;
      if (k === BUSY && overlap > 0) s.busyInShiftMs[r]! += v * overlap;
    }
    o[base] = fleet;
  }

  // Levels. Close each Ready stretch at the boundary before the takes reset the areas.
  let readyArea = 0;
  let readyMs = 0;
  let kvMax = 0;
  for (let r = 0; r < R; r++) {
    const kv = rm.kvUsed[r]!;
    if (s.ready[r] === 1) {
      s.readyKvArea[r]! += levelAreaAt(kv, boundaryMs) - s.markArea[r]!;
      s.readyMs[r]! += boundaryMs - s.markMs[r]!;
    }
    readyArea += s.readyKvArea[r]!;
    readyMs += s.readyMs[r]!;
    o[MI.kvUsedFracMax * S + r + 1] = kv.max;
    if (kv.max > kvMax) kvMax = kv.max;
    o[MI.kvUsedFrac * S + r + 1] = takeLevelMean(kv, boundaryMs);
    s.readyKvArea[r] = 0;
    s.readyMs[r] = 0;
    s.markArea[r] = 0; // the take restarted the level's area at the boundary
    s.markMs[r] = boundaryMs;
    for (let l = 0; l < LEVELS.length; l++) {
      const v = takeLevelMean(rm[LEVELS[l]!][r]!, boundaryMs);
      o[LEVEL_METRIC[l]! * S + r + 1] = v;
      o[LEVEL_METRIC[l]! * S] += v;
    }
  }
  o[MI.kvUsedFrac * S] = readyMs > 0 ? readyArea / readyMs : 0;
  o[MI.kvUsedFracMax * S] = kvMax;
  o[MI.readyReplicas * S] = takeLevelMean(s.readyCount, boundaryMs);
  o[MI.abandonedSessions * S] = meters.fleet.abandonedSessions - s.prevAbandoned;
  s.prevAbandoned = meters.fleet.abandonedSessions;

  // Move the bucket out (Float64 → Float32) and open the next one.
  const at = pushScalarBucket(s);
  const data = s.scalars.data;
  for (let m = 0; m < SCALAR_METRIC_NAMES.length; m++) {
    data[SCALAR_METRIC_NAMES[m]!].set(o.subarray(m * S, m * S + S), at);
  }
  o.fill(0);
  s.bucketStartMs = boundaryMs;

  if (boundaryMs % histBucketMs === 0) {
    pushHistBucket(s, s.openHist);
    for (const h of Object.values(s.openHist)) h.fill(0);
    s.histStartMs = boundaryMs;
  }
}

/** The complete buckets and the records produced during the advance; empties the slice. */
export function produceChunk(state: DayState, span: ChunkSpan, ctx: Ctx): ResultChunk {
  const s = state.metrics;
  const { config, day, detail } = ctx.input;
  const { bucketMs, histBucketMs } = config;
  const sc = s.scalars;
  if (sc.startMs !== span.bucketsFromMs || sc.startMs + sc.count * bucketMs !== span.bucketsToMs) {
    throw new Error(
      `metrics: pending buckets [${sc.startMs}, +${sc.count}) do not match the span [${span.bucketsFromMs}, ${span.bucketsToMs})`,
    );
  }
  const h = s.hists;
  const histFrom = Math.floor(span.bucketsFromMs / histBucketMs) * histBucketMs;
  const histTo = Math.floor(span.bucketsToMs / histBucketMs) * histBucketMs;
  if (h.startMs !== histFrom || h.startMs + h.count * histBucketMs !== histTo) {
    throw new Error(`metrics: pending histograms do not match [${histFrom}, ${histTo})`);
  }
  const chunk: ResultChunk = {
    day,
    fromMs: span.fromMs,
    toMs: span.toMs,
    replicas: s.replicas,
    scalars: exactScalars(sc),
    histograms: sparseHists(h, histBucketMs),
    requests: exactRequests(s.requests, detail),
    transitions: exactTransitions(s.transitions, detail),
    replicaEvents: s.replicaEvents,
  };
  resetPending(s, bucketMs, span.toMs);
  return chunk;
}
