import { describe, expect, it } from 'vitest';
import {
  cumulativeWeights,
  exponential,
  geometric,
  logLogistic,
  logLogisticMean,
  lognormal,
  lognormalMean,
  uniform,
  uniformInt,
  weightedIndex,
} from './distributions.ts';
import { u01 } from './keyed.ts';
import { Source } from './sources.ts';

// Statistical checks over 10^5 keyed draws per distribution. Seeds are fixed, so each check passes or
// fails deterministically; thresholds are 5 standard errors, or the 0.1% critical value for
// chi-square and Kolmogorov–Smirnov, so a wrong parameterization fails by a wide margin.

const N = 100_000;
const Z = 5;
/** Kolmogorov–Smirnov critical distance at α = 0.001 for n = 10^5. */
const KS_CRIT = 0.00616;
/** Chi-square critical values at α = 0.001, by degrees of freedom. */
const CHI2_CRIT: Record<number, number> = { 3: 16.27, 6: 22.46, 15: 37.7, 99: 148.23 };
/** Standard normal quantiles (mpmath), independent of normalQuantile. */
const Z_AT: Record<number, number> = {
  0.01: -2.3263478740408408,
  0.1: -1.2815515655446004,
  0.25: -0.6744897501960817,
  0.5: 0,
  0.75: 0.6744897501960817,
  0.9: 1.2815515655446004,
  0.99: 2.3263478740408408,
};
const PS = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
const U_MAX = 1 - 2 ** -53;

/** N keyed draws: transform(u01(seed, source, 0, i)) for i < N. */
function sample(seed: number, transform: (u: number) => number): Float64Array {
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = transform(u01(seed, Source.oracleWorkload, 0, i));
  return x;
}

function meanOf(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return s / x.length;
}

function varianceOf(x: ArrayLike<number>): number {
  const m = meanOf(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i]! - m) ** 2;
  return s / (x.length - 1);
}

/**
 * Sample mean and variance within Z standard errors of theory. mu4 is the fourth central moment,
 * which sets the standard error of the sample variance: sqrt((mu4 - variance²) / N).
 */
function expectMoments(x: Float64Array, mean: number, variance: number, mu4: number): void {
  const zMean = (meanOf(x) - mean) / Math.sqrt(variance / N);
  const zVar = (varianceOf(x) - variance) / Math.sqrt((mu4 - variance * variance) / N);
  expect(Math.abs(zMean), `mean ${meanOf(x)} vs ${mean}`).toBeLessThan(Z);
  expect(Math.abs(zVar), `variance ${varianceOf(x)} vs ${variance}`).toBeLessThan(Z);
}

/** Fourth central moment from raw moments E[X^k], k = 1 … 4. */
function centralMu4(m1: number, m2: number, m3: number, m4: number): number {
  return m4 - 4 * m3 * m1 + 6 * m2 * m1 * m1 - 3 * m1 ** 4;
}

/** The empirical CDF at each theoretical quantile Q(p) is within Z standard errors of p. */
function expectQuantiles(x: Float64Array, quantile: (p: number) => number): void {
  const sorted = Float64Array.from(x).sort();
  for (const p of PS) {
    const q = quantile(p);
    let below = 0;
    while (below < N && sorted[below]! <= q) below++;
    const se = Math.sqrt((p * (1 - p)) / N);
    expect(Math.abs(below / N - p) / se, `quantile ${p}`).toBeLessThan(Z);
  }
}

/** Kolmogorov–Smirnov distance between the sample and a continuous CDF. */
function ksDistance(x: Float64Array, cdf: (v: number) => number): number {
  const sorted = Float64Array.from(x).sort();
  let d = 0;
  for (let i = 0; i < N; i++) {
    const f = cdf(sorted[i]!);
    d = Math.max(d, (i + 1) / N - f, f - i / N);
  }
  return d;
}

function chiSquare(observed: ArrayLike<number>, expected: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < observed.length; i++) s += (observed[i]! - expected[i]!) ** 2 / expected[i]!;
  return s;
}

function expectMonotone(transform: (u: number) => number): void {
  let prev = -Infinity;
  for (let k = 0; k <= 1000; k++) {
    const x = transform(k === 1000 ? U_MAX : k / 1000);
    expect(x).toBeGreaterThanOrEqual(prev);
    prev = x;
  }
}

describe('uniform', () => {
  it('u01 matches U[0, 1): moments, quantiles, KS, and 100-bin chi-square', () => {
    const x = sample(1, (u) => u);
    expectMoments(x, 1 / 2, 1 / 12, 1 / 80);
    expectQuantiles(x, (p) => p);
    expect(ksDistance(x, (v) => v)).toBeLessThan(KS_CRIT);
    const counts = new Float64Array(100);
    for (const v of x) counts[Math.floor(v * 100)]! += 1;
    expect(chiSquare(counts, new Float64Array(100).fill(N / 100))).toBeLessThan(CHI2_CRIT[99]!);
  });

  it('uniform(lo, hi) scales it', () => {
    const x = sample(2, (u) => uniform(u, 10, 30));
    expectMoments(x, 20, 400 / 12, 20 ** 4 / 80);
    expect(uniform(0, 10, 30)).toBe(10);
  });

  it('uniformInt(n) is uniform on 0 … n-1 and never returns n', () => {
    const x = sample(3, (u) => uniformInt(u, 7));
    const counts = new Float64Array(7);
    for (const v of x) {
      expect(Number.isInteger(v) && v >= 0 && v < 7).toBe(true);
      counts[v]! += 1;
    }
    expect(chiSquare(counts, new Float64Array(7).fill(N / 7))).toBeLessThan(CHI2_CRIT[6]!);
    // Discrete uniform on 0 … n-1: variance (n² - 1) / 12, mu4 (n² - 1)(3n² - 7) / 240.
    expectMoments(x, 3, (7 ** 2 - 1) / 12, ((7 ** 2 - 1) * (3 * 7 ** 2 - 7)) / 240);
    for (const n of [1, 2, 3, 7, 1000, 2 ** 31 - 1, 2 ** 32 + 1, 2 ** 53]) {
      expect(uniformInt(U_MAX, n)).toBe(n - 1);
      expect(uniformInt(0, n)).toBe(0);
    }
  });
});

describe('exponential', () => {
  const mean = 250;
  it('matches Exp(mean): moments, quantiles, KS', () => {
    const x = sample(4, (u) => exponential(u, mean));
    expectMoments(x, mean, mean ** 2, 9 * mean ** 4);
    expectQuantiles(x, (p) => -mean * Math.log(1 - p));
    expect(ksDistance(x, (v) => 1 - Math.exp(-v / mean))).toBeLessThan(KS_CRIT);
  });

  it('is finite and monotone on [0, 1)', () => {
    expect(exponential(0, mean)).toBe(0);
    expect(Number.isFinite(exponential(U_MAX, mean))).toBe(true);
    expectMonotone((u) => exponential(u, mean));
  });
});

describe('lognormal', () => {
  const median = 400;
  const sigma = 0.8;
  it('matches LogNormal(ln median, sigma²): moments, quantiles, and the log-space normal', () => {
    const x = sample(5, (u) => lognormal(u, median, sigma));
    // Raw moments E[X^k] = median^k · e^(k² σ² / 2).
    const raw = (k: number) => median ** k * Math.exp((k * k * sigma * sigma) / 2);
    const mean = lognormalMean(median, sigma);
    expect(mean).toBeCloseTo(raw(1), 9);
    expectMoments(x, mean, raw(2) - mean ** 2, centralMu4(raw(1), raw(2), raw(3), raw(4)));
    expectQuantiles(x, (p) => median * Math.exp(sigma * Z_AT[p]!));

    const logs = x.map(Math.log);
    expectMoments(logs, Math.log(median), sigma ** 2, 3 * sigma ** 4);
  });

  it('handles sigma = 0, u = 0, and the tails', () => {
    expect(lognormal(0.3, median, 0)).toBe(median);
    expect(lognormal(0, median, sigma)).toBe(0);
    expect(lognormal(0.5, median, sigma)).toBe(median);
    expect(Number.isFinite(lognormal(U_MAX, median, sigma))).toBe(true);
    expectMonotone((u) => lognormal(u, median, sigma));
  });
});

describe('geometric', () => {
  it('matches Geometric(p = 1 / mean) on 1, 2, …: pmf chi-square and moments', () => {
    const mean = 4;
    const p = 1 / mean;
    const x = sample(6, (u) => geometric(u, mean));
    // Bins k = 1 … 15, then k ≥ 16.
    const observed = new Float64Array(16);
    const expected = new Float64Array(16);
    for (const k of x) {
      expect(Number.isInteger(k) && k >= 1).toBe(true);
      observed[Math.min(k, 16) - 1]! += 1;
    }
    for (let k = 1; k <= 15; k++) expected[k - 1] = N * (1 - p) ** (k - 1) * p;
    expected[15] = N * (1 - p) ** 15;
    expect(chiSquare(observed, expected)).toBeLessThan(CHI2_CRIT[15]!);

    const variance = (1 - p) / p ** 2;
    // Excess kurtosis 6 + p² / (1 - p).
    expectMoments(x, mean, variance, variance ** 2 * (9 + p ** 2 / (1 - p)));
  });

  it('matches other means', () => {
    for (const mean of [1.5, 12]) {
      const p = 1 / mean;
      const variance = (1 - p) / p ** 2;
      const x = sample(7, (u) => geometric(u, mean));
      expectMoments(x, mean, variance, variance ** 2 * (9 + p ** 2 / (1 - p)));
    }
  });

  it('gives single-turn sessions for a mean of 1 or less, and is monotone', () => {
    for (const u of [0, 0.5, U_MAX]) {
      expect(geometric(u, 1)).toBe(1);
      expect(geometric(u, 0.5)).toBe(1);
    }
    expect(geometric(0, 4)).toBe(1);
    expect(Number.isFinite(geometric(U_MAX, 4))).toBe(true);
    expectMonotone((u) => geometric(u, 4));
  });
});

describe('logLogistic (think time)', () => {
  // Fixture defaults: median 90 s, shape 2.
  const median = 90_000;
  it('shape 2: median, quantiles, KS, and the log-space logistic', () => {
    const shape = 2;
    const x = sample(8, (u) => logLogistic(u, median, shape));
    expectQuantiles(x, (p) => median * (p / (1 - p)) ** (1 / shape));
    expect(ksDistance(x, (t) => 1 / (1 + (t / median) ** -shape))).toBeLessThan(KS_CRIT);
    // ln T is logistic with location ln(median) and scale 1/shape: variance π²/(3β²), kurtosis 4.2.
    const logVar = Math.PI ** 2 / (3 * shape ** 2);
    expectMoments(x.map(Math.log), Math.log(median), logVar, 4.2 * logVar ** 2);
  });

  it('shape 6: mean and variance (finite fourth moment needs shape > 4)', () => {
    const shape = 6;
    const x = sample(9, (u) => logLogistic(u, median, shape));
    // Raw moments E[T^k] = median^k · (kπ/β) / sin(kπ/β) for k < β.
    const raw = (k: number) =>
      median ** k * ((k * Math.PI) / shape / Math.sin((k * Math.PI) / shape));
    expect(logLogisticMean(median, shape)).toBeCloseTo(raw(1), 6);
    expectMoments(
      x,
      logLogisticMean(median, shape),
      raw(2) - raw(1) ** 2,
      centralMu4(raw(1), raw(2), raw(3), raw(4)),
    );
  });

  it('returns the median at u = 0.5, 0 at u = 0, and is monotone', () => {
    expect(logLogistic(0.5, median, 2)).toBe(median);
    expect(logLogistic(0, median, 2)).toBe(0);
    expect(Number.isFinite(logLogistic(U_MAX, median, 2))).toBe(true);
    expect(logLogisticMean(median, 1)).toBe(Infinity);
    expectMonotone((u) => logLogistic(u, median, 3));
  });
});

describe('weightedIndex', () => {
  it('chooses in proportion to the weights and never picks a zero weight', () => {
    const weights = [1, 0, 3, 6, 0];
    const cumulative = cumulativeWeights(weights);
    const counts = new Float64Array(weights.length);
    for (let i = 0; i < N; i++)
      counts[weightedIndex(u01(10, Source.sessionAnalyst, 0, i), cumulative)]! += 1;
    expect(counts[1]).toBe(0);
    expect(counts[4]).toBe(0);
    const observed = [counts[0]!, counts[2]!, counts[3]!];
    const expected = [N * 0.1, N * 0.3, N * 0.6];
    expect(chiSquare(observed, expected)).toBeLessThan(CHI2_CRIT[3]!);
  });

  it('picks the first and last positive weights at the ends of [0, 1)', () => {
    const c = cumulativeWeights([0, 0, 2, 5, 0]);
    expect(weightedIndex(0, c)).toBe(2);
    expect(weightedIndex(U_MAX, c)).toBe(3);
    expect(weightedIndex(2 / 7 - 1e-12, c)).toBe(2);
    expect(weightedIndex(2 / 7 + 1e-12, c)).toBe(3);
    expectMonotone((u) => weightedIndex(u, c));
  });

  it('uses only the first `count` entries of a reused scratch array', () => {
    const scratch = new Float64Array(8);
    cumulativeWeights([1, 1, 1, 1, 1, 1, 1, 1], scratch);
    const c = cumulativeWeights([1, 3], scratch);
    expect(c).toBe(scratch);
    expect(weightedIndex(0.2, c, 2)).toBe(0);
    expect(weightedIndex(0.3, c, 2)).toBe(1);
    expect(weightedIndex(U_MAX, c, 2)).toBe(1);
  });

  it('rejects negative, non-finite, and all-zero weights', () => {
    expect(() => cumulativeWeights([1, -1])).toThrow(RangeError);
    expect(() => cumulativeWeights([1, NaN])).toThrow(RangeError);
    expect(() => cumulativeWeights([1, Infinity])).toThrow(RangeError);
    expect(() => cumulativeWeights([0, 0])).toThrow(RangeError);
    expect(() => cumulativeWeights([1, 2], new Float64Array(1))).toThrow(RangeError);
  });
});
