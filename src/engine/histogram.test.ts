import { describe, expect, it } from 'vitest';
import {
  HISTOGRAM_SPECS,
  binIndex,
  binLowerMs,
  mergeInto,
  quantile,
  totalCount,
} from './histogram.ts';

const spec = HISTOGRAM_SPECS.ttft;

function fill(values: number[]): Uint32Array {
  const counts = new Uint32Array(spec.bins);
  for (const v of values) counts[binIndex(spec, v)]! += 1;
  return counts;
}

describe('histogram', () => {
  it('places values in the bin whose range contains them', () => {
    for (const v of [1.5, 10, 123, 4_567, 99_999]) {
      const i = binIndex(spec, v);
      expect(binLowerMs(spec, i)).toBeLessThanOrEqual(v);
      expect(binLowerMs(spec, i + 1)).toBeGreaterThan(v);
    }
  });

  it('clamps underflow and overflow', () => {
    expect(binIndex(spec, 0)).toBe(0);
    expect(binIndex(spec, -5)).toBe(0);
    expect(binIndex(spec, 1e12)).toBe(spec.bins - 1);
  });

  it('merges exactly', () => {
    const a = fill([10, 20, 30]);
    const b = fill([20, 40_000]);
    const merged = new Uint32Array(spec.bins);
    mergeInto(merged, 0, a, 0, spec.bins);
    mergeInto(merged, 0, b, 0, spec.bins);
    expect(totalCount(merged, 0, spec.bins)).toBe(5);
    expect(merged[binIndex(spec, 20)]).toBe(2);
  });

  it('estimates quantiles within one bin width', () => {
    // Deterministic spread of values from 50 ms to 5,000 ms.
    const values = Array.from({ length: 10_000 }, (_, i) => 50 * Math.pow(100, i / 9_999));
    const counts = fill(values);
    const binRatio = Math.pow(spec.maxMs / spec.minMs, 1 / spec.bins);
    for (const q of [0.5, 0.9, 0.99]) {
      const exact = values[Math.ceil(q * values.length) - 1]!;
      const est = quantile(spec, counts, 0, q);
      expect(est / exact).toBeGreaterThan(1 / binRatio);
      expect(est / exact).toBeLessThan(binRatio);
    }
  });

  it('returns NaN for an empty histogram', () => {
    expect(quantile(spec, new Uint32Array(spec.bins), 0, 0.99)).toBeNaN();
  });
});
