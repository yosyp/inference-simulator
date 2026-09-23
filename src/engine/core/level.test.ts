import { describe, expect, it } from 'vitest';
import { addLevel, createLevel, setLevel, takeLevelMean } from './level.ts';

describe('time-weighted level', () => {
  it('averages a step function over each take interval', () => {
    const l = createLevel(0, 2);
    setLevel(l, 4, 6); // 2 for 4 ms
    addLevel(l, 6, -6); // 6 for 2 ms
    expect(l.max).toBe(6);
    expect(takeLevelMean(l, 10)).toBeCloseTo((2 * 4 + 6 * 2 + 0 * 4) / 10, 12);
    expect(l.max).toBe(0);
    addLevel(l, 15, 1);
    expect(takeLevelMean(l, 20)).toBeCloseTo(0.5, 12);
    expect(takeLevelMean(l, 20)).toBe(1); // empty interval: the current value
  });

  it('matches a brute-force integral over random changes', () => {
    let seed = 99;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const l = createLevel(0, 0);
    let t = 0;
    let v = 0;
    let area = 0;
    const bucket = 100;
    let nextTake = bucket;
    for (let i = 0; i < 1000; i++) {
      const next = t + rand() * 30;
      while (nextTake <= next) {
        area += v * (nextTake - t);
        t = nextTake;
        expect(takeLevelMean(l, nextTake)).toBeCloseTo(area / bucket, 9);
        area = 0;
        nextTake += bucket;
      }
      area += v * (next - t);
      t = next;
      v = Math.floor(rand() * 10);
      setLevel(l, t, v);
    }
  });

  it('rejects going back in time', () => {
    const l = createLevel(10);
    expect(() => setLevel(l, 9, 1)).toThrow(RangeError);
  });
});
