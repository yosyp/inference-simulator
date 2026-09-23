import { describe, expect, it } from 'vitest';
import { HISTOGRAM_SPECS, binIndex } from '../../engine/histogram.ts';
import {
  REPLICA_STATE,
  allocDenseHistograms,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  histogramBlockFromDense,
  type ResultChunk,
  type ScalarMetric,
} from '../../engine/results.ts';
import {
  amplification,
  goodputShare,
  hitRatesIn,
  kvAtLeastForMs,
  preemptionsIn,
  recomputedPrefillShare,
  rejoinFlood,
  replicaLoadImbalance,
  throughputTokensPerS,
  ttftStatsInWindow,
  utilizationIn,
} from './lessons.ts';
import type { ChunkRun } from './run.ts';
import { longestRun, scalarIn, slide, win } from './window.ts';

// Two replicas, twelve 10 s scalar buckets and two 60 s histogram buckets over [0, 120 s).
const R = 2;
const S = R + 1;
const N = 12;
const PEAK = 1e12;

function synthetic(set: (m: ScalarMetric, bucket: number, series: number) => number): ChunkRun {
  const scalars = allocScalarBlock(0, 10_000, N, S);
  for (const m of Object.keys(scalars.data) as ScalarMetric[]) {
    for (let b = 0; b < N; b++)
      for (let s = 0; s < S; s++) scalars.data[m][b * S + s] = set(m, b, s);
  }
  // TTFT: fleet cell of the first minute holds 98 samples at 100 ms and 2 at 5000 ms.
  const dense = allocDenseHistograms(2, S);
  const bins = HISTOGRAM_SPECS.ttft.bins;
  dense.ttft[binIndex(HISTOGRAM_SPECS.ttft, 100)] = 98;
  dense.ttft[binIndex(HISTOGRAM_SPECS.ttft, 5000)] = 2;
  dense.ttft[S * bins + binIndex(HISTOGRAM_SPECS.ttft, 400)] = 10; // second minute
  const chunk: ResultChunk = {
    day: 0,
    fromMs: 0,
    toMs: 120_000,
    replicas: R,
    scalars,
    histograms: histogramBlockFromDense(0, 60_000, 2, S, dense),
    requests: allocRequestBlock('all', 0),
    transitions: allocTransitionBlock('all', 0),
    replicaEvents: [
      { atMs: 30_000, replica: 1, state: REPLICA_STATE.crashed },
      { atMs: 60_000, replica: 1, state: REPLICA_STATE.ready },
    ],
  };
  return { chunks: [chunk], replicas: R, peakFlops: PEAK };
}

const run = synthetic((m, b, s) => {
  const fleet = s === 0;
  switch (m) {
    case 'kvUsedFrac':
      return b >= 3 && b < 9 ? 0.97 : 0.5; // 60 s at or above 95%
    case 'busyMs':
      return fleet ? 2 * 9_000 : 9_000; // 90% busy
    case 'flops':
      return fleet ? 2 * 2e12 : 2e12; // 20% of peak over 10 s
    case 'preemptions':
      return fleet ? 2 : 1;
    case 'prefillTokens':
      return 1000;
    case 'recomputedPrefillTokens':
      return 250;
    case 'decodeTokens':
      return 500;
    case 'prefixQueryTokens':
    case 'returningQueryTokens':
      return 100;
    case 'prefixHitTokens':
      return 60;
    case 'returningHitTokens':
      return s === 2 && b >= 6 ? 0 : 80; // replica 1 comes back cold at 60 s
    case 'outstanding':
      return fleet ? 6 : s === 1 ? 1 : 5;
    case 'readyReplicas':
      return 2;
    case 'offered':
      return fleet ? 30 : 0;
    case 'organic':
      return fleet ? 10 : 0;
    case 'finished':
      return fleet ? 4 : 2;
    case 'ttftSumMs':
      return b < 6 && fleet ? 1_000 : 0;
    case 'ttftCount':
      return b < 6 && fleet ? 10 : 0;
    default:
      return 0;
  }
});

describe('window helpers', () => {
  it('aggregates scalars by their kind and ignores buckets outside the window', () => {
    expect(scalarIn(run, 'preemptions', win(0, 60_000))).toBe(12);
    expect(scalarIn(run, 'kvUsedFrac', win(30_000, 90_000))).toBeCloseTo(0.97);
    expect(scalarIn(run, 'preemptions', win(200_000, 300_000))).toBeNaN();
  });

  it('finds the longest run and slides a helper across the window', () => {
    const pts = slide(win(0, 120_000), 30_000, (w) => scalarIn(run, 'kvUsedFrac', w));
    expect(pts.t).toEqual([0, 30_000, 60_000, 90_000]);
    expect(longestRun(pts, (v) => v > 0.9)).toMatchObject({ ms: 60_000, totalMs: 60_000 });
  });
});

describe('lesson helpers', () => {
  const all = win(0, 120_000);

  it('ttftStatsInWindow: mean from sums, percentiles from merged histograms', () => {
    const s = ttftStatsInWindow(run, win(0, 60_000));
    expect(s.count).toBe(60);
    expect(s.meanMs).toBeCloseTo(100);
    expect(s.p50Ms).toBeGreaterThan(93);
    expect(s.p50Ms).toBeLessThan(108);
    expect(s.p99Ms).toBeGreaterThan(4600);
    expect(ttftStatsInWindow(run, win(60_000, 120_000)).count).toBe(0);
  });

  it('kv, preemptions, recompute, throughput, and utilization', () => {
    expect(kvAtLeastForMs(run, 0.95, all)).toMatchObject({
      ms: 60_000,
      window: { fromMs: 30_000, toMs: 90_000 },
    });
    expect(preemptionsIn(run, all)).toBe(24);
    expect(preemptionsIn(run, all, 1)).toBe(12);
    expect(recomputedPrefillShare(run, all)).toBeCloseTo(0.25);
    expect(throughputTokensPerS(run, all).decodePerS).toBeCloseTo(50);
    const u = utilizationIn(run, all);
    expect(u.nvidiaSmi).toBeCloseTo(0.9);
    expect(u.compute).toBeCloseTo(0.2);
    expect(utilizationIn(run, all, 2).nvidiaSmi).toBeCloseTo(0.9);
  });

  it('hit rates, imbalance, amplification, goodput', () => {
    expect(hitRatesIn(run, all)).toEqual({ prefix: 0.6, returning: 0.8 });
    const imb = replicaLoadImbalance(run, all);
    expect(imb.perReplica).toEqual([1, 5]);
    expect(imb.ratio).toBeCloseTo(5 / 3);
    expect(imb.bucketRatio).toBeCloseTo(5 / 3);
    expect(amplification(run, all)).toBeCloseTo(3);
    expect(goodputShare(run, all)).toBeCloseTo(0.4);
  });

  it('rejoinFlood reads the rejoined replica after it is Ready again', () => {
    const f = rejoinFlood(run, 1, 30_000, 60_000);
    expect(f.rejoinMs).toBe(60_000);
    expect(f.hitRates.returning).toBe(0);
    expect(f.outstanding).toBe(5);
    expect(f.fleetMeanOutstanding).toBe(3);
    expect(rejoinFlood(run, 1, 90_000).rejoinMs).toBeNull();
  });
});
