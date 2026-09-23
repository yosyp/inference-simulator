// Inverse-CDF transforms. Each maps one uniform u in [0, 1) to a draw, so a keyed draw is
// `transform(u01(seed, Source.x, ...keys), ...params)` and consumes exactly one uniform. There are
// no rejection loops, so no draw ever needs a second key.
//
// Every transform is non-decreasing in u. Integer results (uniformInt, geometric, weightedIndex)
// use Math.floor and IEEE arithmetic; lognormal, exponential, geometric, and logLogistic also call
// Math.exp, log, log1p, or pow, which may differ in the last bit across JS engines (02 §12).

import { normalQuantile } from './normal.ts';

/** Uniform real in [lo, hi). Rounding can return hi when hi - lo is not exactly representable. */
export function uniform(u: number, lo: number, hi: number): number {
  return lo + u * (hi - lo);
}

/**
 * Uniform integer in [0, n), for an integer n in [1, 2^53]. Exact: IEEE multiply and floor, so
 * identical in every JS engine, and never n, because u ≤ 1 - 2^-53.
 */
export function uniformInt(u: number, n: number): number {
  return Math.floor(u * n);
}

/** Exponential with the given mean (rate 1 / mean). */
export function exponential(u: number, mean: number): number {
  return -mean * Math.log1p(-u);
}

/**
 * Lognormal with the given median and log-space standard deviation sigma: median · e^(sigma·Z).
 * The mean is median · e^(sigma²/2) (see lognormalMean). sigma = 0 returns the median exactly.
 * u = 0 returns 0 (probability 2^-53); round lengths up to at least 1 token.
 */
export function lognormal(u: number, median: number, sigma: number): number {
  return sigma > 0 ? median * Math.exp(sigma * normalQuantile(u)) : median;
}

export function lognormalMean(median: number, sigma: number): number {
  return median * Math.exp((sigma * sigma) / 2);
}

/**
 * Geometric on 1, 2, 3, … with the given mean (≥ 1): P(K = k) = (1 - p)^(k-1) · p with p = 1 / mean.
 * A mean of 1 or less always gives 1, e.g. single-turn sessions (01 §5 step c1).
 */
export function geometric(u: number, mean: number): number {
  if (!(mean > 1)) return 1;
  return 1 + Math.floor(Math.log1p(-u) / Math.log1p(-1 / mean));
}

/**
 * Log-logistic with the given median and shape β > 0, the think-time family (02 §8):
 * F(t) = 1 / (1 + (t / median)^-β), so the quantile is median · (u / (1 - u))^(1/β).
 *
 * Why log-logistic rather than gamma (00-build E1):
 * - Its inverse CDF is closed form, so each draw is one uniform and one pow. Gamma has no closed-form
 *   inverse: it needs rejection sampling (a variable number of uniforms per draw, which breaks
 *   one-draw-per-key) or a slow iterative inverse.
 * - The median is a parameter, and TunableParams.thinkTimeMedianMs is a median. Gamma's median has
 *   no closed form.
 * - Its right tail is a power law, P(T > t) ≈ (t / median)^-β. Occasional long pauses (a meeting, a
 *   long read) are what decide whether a session's history survives in the KV cache (tab 4). A gamma
 *   tail decays exponentially and would make long absences rarer.
 *
 * The tail is heavy: the mean is finite only for β > 1 (see logLogisticMean) and the variance only
 * for β > 2. Quantiles are median · (q / (1 - q))^(1/β): at β = 2, p90 = 3× and p99 ≈ 9.9× the
 * median; at β = 3, p90 ≈ 2.1× and p99 ≈ 4.6×. A caller that needs a bound (the end of the shift)
 * caps the draw.
 */
export function logLogistic(u: number, median: number, shape: number): number {
  return median * Math.pow(u / (1 - u), 1 / shape);
}

/** Mean of logLogistic(median, shape): median · (π/β) / sin(π/β); Infinity for β ≤ 1. */
export function logLogisticMean(median: number, shape: number): number {
  if (!(shape > 1)) return Infinity;
  const b = Math.PI / shape;
  return (median * b) / Math.sin(b);
}

/**
 * Cumulative sums of non-negative weights, for weightedIndex. Allocate once and reuse: pass `out` to
 * refill an existing array. Throws if a weight is negative or not finite, or if all are zero.
 */
export function cumulativeWeights(
  weights: ArrayLike<number>,
  out: Float64Array = new Float64Array(weights.length),
): Float64Array {
  if (out.length < weights.length) throw new RangeError('cumulativeWeights: out is too short');
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (!(w >= 0 && w < Infinity)) throw new RangeError(`cumulativeWeights: bad weight ${w}`);
    total += w;
    out[i] = total;
  }
  if (!(total > 0)) throw new RangeError('cumulativeWeights: weights sum to zero');
  return out;
}

/**
 * Weighted choice: index i with probability weight[i] / total, from cumulative weights (see
 * cumulativeWeights). `count` is how many entries of `cumulative` are in use (default: all), so a
 * reused scratch array can be longer. Zero-weight entries are never chosen. Binary search, no
 * allocation; pass a Float64Array for speed. The total (cumulative[count - 1]) must be positive.
 */
export function weightedIndex(
  u: number,
  cumulative: ArrayLike<number>,
  count: number = cumulative.length,
): number {
  const target = u * cumulative[count - 1]!;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid]! > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
