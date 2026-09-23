import { describe, expect, it } from 'vitest';
import {
  coversRange,
  isComputedAt,
  normalizeRanges,
  rangeEndAt,
  sameRanges,
  subtractRange,
} from './ranges.ts';

const r = (fromMs: number, toMs: number) => ({ fromMs, toMs });

describe('computed ranges', () => {
  it('sorts, drops empty ranges, and merges overlapping or touching ones', () => {
    expect(
      normalizeRanges([r(50, 60), r(0, 10), r(10, 20), r(5, 8), r(30, 30), r(55, 70)]),
    ).toEqual([r(0, 20), r(50, 70)]);
  });

  it('finds the end of the range containing a time (half-open)', () => {
    const ranges = [r(0, 20), r(50, 70)];
    expect(rangeEndAt(ranges, 0)).toBe(20);
    expect(rangeEndAt(ranges, 19.5)).toBe(20);
    expect(rangeEndAt(ranges, 20)).toBeNull();
    expect(rangeEndAt(ranges, 60)).toBe(70);
    expect(rangeEndAt(ranges, -1)).toBeNull();
    expect(isComputedAt(ranges, 69)).toBe(true);
    expect(isComputedAt(ranges, 70)).toBe(false);
  });

  it('checks whole-window coverage', () => {
    const ranges = [r(0, 20), r(50, 70)];
    expect(coversRange(ranges, 5, 20)).toBe(true);
    expect(coversRange(ranges, 5, 21)).toBe(false);
    expect(coversRange(ranges, 20, 30)).toBe(false);
  });

  it('subtracts a window', () => {
    const ranges = [r(0, 20), r(50, 70)];
    expect(subtractRange(ranges, 10, 60)).toEqual([r(0, 10), r(60, 70)]);
    expect(subtractRange(ranges, 0, 100)).toEqual([]);
    expect(subtractRange(ranges, 30, 40)).toEqual(ranges);
    expect(sameRanges(subtractRange(ranges, 30, 40), ranges)).toBe(true);
    expect(sameRanges(ranges, [r(0, 20)])).toBe(false);
  });
});
