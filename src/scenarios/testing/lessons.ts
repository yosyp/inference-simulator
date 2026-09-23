// Lesson helpers over a run's chunks (00-build C1, §7.3). Each takes a window and, where it makes
// sense, a series (0 = fleet, r + 1 = replica r; results.ts replicaSeries). See window.ts for how
// buckets map to windows. Ratios read NaN when their denominator is zero.

import type { HistogramMetric } from '../../engine/histogram.ts';
import {
  FLEET_SERIES,
  REPLICA_STATE,
  replicaSeries,
  type ScalarMetric,
} from '../../engine/results.ts';
import { MINUTE_MS, type SimMs } from '../../engine/time.ts';
import type { ChunkRun } from './run.ts';
import {
  longestRun,
  quantilesIn,
  scalarIn,
  scalarPoints,
  scalarWindow,
  type Run,
  type TimeWindow,
} from './window.ts';

export interface LatencyStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
}

const SUM_COUNT = {
  ttft: ['ttftSumMs', 'ttftCount'],
  tpot: ['tpotSumMs', 'tpotCount'],
  e2e: ['e2eSumMs', 'e2eCount'],
} as const satisfies Record<HistogramMetric, readonly [ScalarMetric, ScalarMetric]>;

/**
 * Latency over the window as the charts show it: the mean from the exact sums, p50 and p99 from
 * the merged histograms. TTFT samples land when the first token does; TPOT and E2E at the end.
 */
export function latencyStatsInWindow(
  run: ChunkRun,
  metric: HistogramMetric,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): LatencyStats {
  const [sumM, countM] = SUM_COUNT[metric];
  const sum = scalarIn(run, sumM, window, series);
  const count = scalarIn(run, countM, window, series);
  const [p50, p99] = quantilesIn(run, metric, window, [0.5, 0.99], series);
  return {
    count: Number.isNaN(count) ? 0 : count,
    meanMs: count > 0 ? sum / count : NaN,
    p50Ms: p50!,
    p99Ms: p99!,
  };
}

export function ttftStatsInWindow(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): LatencyStats {
  return latencyStatsInWindow(run, 'ttft', window, series);
}

function perS(run: ChunkRun, metric: ScalarMetric, window: TimeWindow, series: number): number {
  const w = scalarWindow(run, metric, window, series);
  return w.ms > 0 ? (w.value * 1000) / w.ms : NaN;
}

export interface Throughput {
  /** Generated tokens per second. */
  decodePerS: number;
  /** Prompt tokens computed per second (cache hits excluded, recompute included). */
  prefillPerS: number;
  totalPerS: number;
}

export function throughputTokensPerS(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): Throughput {
  const decodePerS = perS(run, 'decodeTokens', window, series);
  const prefillPerS = perS(run, 'prefillTokens', window, series);
  return { decodePerS, prefillPerS, totalPerS: decodePerS + prefillPerS };
}

/**
 * Stretches where KV use is at least `frac` (0..1), per scalar bucket. The default signal is
 * kvUsedFrac, the bucket's time-weighted mean (the fleet series averages Ready replicas); pass
 * 'kvUsedFracMax' for the bucket's peak.
 */
export function kvAtLeastForMs(
  run: ChunkRun,
  frac: number,
  window: TimeWindow,
  options: { series?: number; metric?: 'kvUsedFrac' | 'kvUsedFracMax' } = {},
): Run {
  const pts = scalarPoints(run, options.metric ?? 'kvUsedFrac', window, options.series);
  return longestRun(pts, (v) => v >= frac);
}

export function preemptionsIn(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): number {
  return scalarIn(run, 'preemptions', window, series);
}

/** Recomputed prefill tokens ÷ all prefill tokens computed in the window (tab 3). */
export function recomputedPrefillShare(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): number {
  const prefill = scalarIn(run, 'prefillTokens', window, series);
  return prefill > 0 ? scalarIn(run, 'recomputedPrefillTokens', window, series) / prefill : NaN;
}

export interface Utilization {
  /** Share of time a step was executing (nvidia-smi's "GPU-Util"), 0..1. */
  nvidiaSmi: number;
  /** Achieved FLOPS ÷ peak, 0..η_c. */
  compute: number;
}

/** Utilization over the window. The fleet series averages over all replicas, Ready or not. */
export function utilizationIn(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): Utilization {
  const gpus = series === FLEET_SERIES ? run.replicas : 1;
  const busy = scalarWindow(run, 'busyMs', window, series);
  const flops = scalarWindow(run, 'flops', window, series);
  return {
    nvidiaSmi: busy.ms > 0 ? busy.value / (busy.ms * gpus) : NaN,
    compute: flops.ms > 0 ? flops.value / ((run.peakFlops * flops.ms * gpus) / 1000) : NaN,
  };
}

export interface HitRates {
  /** Prefix-cache hit tokens ÷ lookup tokens, every request. */
  prefix: number;
  /** The same for returning turns (turn >= 2) only (tab 4). */
  returning: number;
}

export function hitRatesIn(
  run: ChunkRun,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): HitRates {
  const ratio = (hit: ScalarMetric, query: ScalarMetric) => {
    const q = scalarIn(run, query, window, series);
    return q > 0 ? scalarIn(run, hit, window, series) / q : NaN;
  };
  return {
    prefix: ratio('prefixHitTokens', 'prefixQueryTokens'),
    returning: ratio('returningHitTokens', 'returningQueryTokens'),
  };
}

export interface LoadImbalance {
  /** Each replica's mean load over the window. */
  perReplica: number[];
  /** max ÷ mean of perReplica: 1 is perfectly balanced. */
  ratio: number;
  /** The same ratio per scalar bucket, averaged over buckets with any load (catches a hot spot that moves). */
  bucketRatio: number;
}

/** Replica-load imbalance; the load signal defaults to the router's outstanding count. */
export function replicaLoadImbalance(
  run: ChunkRun,
  window: TimeWindow,
  metric: ScalarMetric = 'outstanding',
): LoadImbalance {
  const series = Array.from({ length: run.replicas }, (_, r) =>
    scalarPoints(run, metric, window, replicaSeries(r)),
  );
  const perReplica = series.map((p) =>
    p.v.length > 0 ? p.v.reduce((a, b) => a + b, 0) / p.v.length : NaN,
  );
  const maxOverMean = (vs: number[]) => {
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
    return mean > 0 ? Math.max(...vs) / mean : NaN;
  };
  let sum = 0;
  let n = 0;
  const buckets = series[0]?.v.length ?? 0;
  for (let i = 0; i < buckets; i++) {
    const r = maxOverMean(series.map((p) => p.v[i]!));
    if (!Number.isNaN(r)) {
      sum += r;
      n++;
    }
  }
  return { perReplica, ratio: maxOverMean(perReplica), bucketRatio: n > 0 ? sum / n : NaN };
}

/** Arrivals at the router (retries included) ÷ first attempts (tab 6). */
export function amplification(run: ChunkRun, window: TimeWindow): number {
  const organic = scalarIn(run, 'organic', window);
  return organic > 0 ? scalarIn(run, 'offered', window) / organic : NaN;
}

/** Requests served ÷ first attempts: the share of organic demand the fleet delivers (tab 6). */
export function goodputShare(run: ChunkRun, window: TimeWindow): number {
  const organic = scalarIn(run, 'organic', window);
  return organic > 0 ? scalarIn(run, 'finished', window) / organic : NaN;
}

export interface RequestCounts {
  offered: number;
  organic: number;
  retries: number;
  dispatched: number;
  finished: number;
  timedOut: number;
  rejected: number;
  failed: number;
  abandonedSessions: number;
}

/** Fleet request counts over the window (0 where there are no buckets). */
export function requestCountsIn(run: ChunkRun, window: TimeWindow): RequestCounts {
  const n = (m: ScalarMetric) => scalarIn(run, m, window) || 0;
  return {
    offered: n('offered'),
    organic: n('organic'),
    retries: n('retries'),
    dispatched: n('dispatched'),
    finished: n('finished'),
    timedOut: n('timedOut'),
    rejected: n('rejected'),
    failed: n('failed'),
    abandonedSessions: n('abandonedSessions'),
  };
}

/** When the replica next became Ready at or after afterMs, from the chunks' replica events. */
export function readyAtOrAfter(run: ChunkRun, replica: number, afterMs: SimMs): SimMs | null {
  for (const c of run.chunks) {
    for (const e of c.replicaEvents) {
      if (e.replica === replica && e.state === REPLICA_STATE.ready && e.atMs >= afterMs) {
        return e.atMs;
      }
    }
  }
  return null;
}

export interface RejoinFlood {
  /** When the replica became Ready again, or null if it didn't by the run's end. */
  rejoinMs: SimMs | null;
  /** [rejoinMs, rejoinMs + spanMs), or null. */
  window: TimeWindow | null;
  /** The rejoined replica's prefix and returning hit rates over the window. */
  hitRates: HitRates;
  /** Its mean outstanding count over the window. */
  outstanding: number;
  /** Fleet outstanding ÷ Ready replicas, averaged over the window. */
  fleetMeanOutstanding: number;
}

/**
 * Tab 5's rejoin: a recovered replica has a cold cache and low load, so least-outstanding floods
 * it. Looks at the first spanMs (default 2 minutes) after it is Ready again.
 */
export function rejoinFlood(
  run: ChunkRun,
  replica: number,
  afterMs: SimMs,
  spanMs: number = 2 * MINUTE_MS,
): RejoinFlood {
  const rejoinMs = readyAtOrAfter(run, replica, afterMs);
  if (rejoinMs === null) {
    return {
      rejoinMs,
      window: null,
      hitRates: { prefix: NaN, returning: NaN },
      outstanding: NaN,
      fleetMeanOutstanding: NaN,
    };
  }
  const window = { fromMs: rejoinMs, toMs: rejoinMs + spanMs };
  const s = replicaSeries(replica);
  const fleet = scalarPoints(run, 'outstanding', window);
  const ready = scalarPoints(run, 'readyReplicas', window);
  let sum = 0;
  for (let i = 0; i < fleet.v.length; i++) sum += ready.v[i]! > 0 ? fleet.v[i]! / ready.v[i]! : 0;
  return {
    rejoinMs,
    window,
    hitRates: hitRatesIn(run, window, s),
    outstanding: scalarIn(run, 'outstanding', window, s),
    fleetMeanOutstanding: fleet.v.length > 0 ? sum / fleet.v.length : NaN,
  };
}
