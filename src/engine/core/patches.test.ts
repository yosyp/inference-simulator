import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch } from '../api.ts';
import { DAY_MS, dayStartMs } from '../time.ts';
import { dayStartParams, partitionPatches, samePatchList } from './patches.ts';

const crash = { type: 'crash' as const, replica: 0 };

describe('partitionPatches (K21)', () => {
  const d2 = dayStartMs(2);
  const patches: Patch[] = [
    { kind: 'event', atMs: d2 + 5, event: crash }, // 0 in-day
    { kind: 'set', atMs: d2 - 1, changes: { maxRetries: 1 } }, // 1 pre-day
    { kind: 'set', atMs: d2 + 5, changes: { maxRetries: 2 } }, // 2 in-day, after 0 (input order)
    { kind: 'event', atMs: d2 - 1, event: crash }, // 3 earlier day: ignored
    { kind: 'set', atMs: 0, changes: { maxRetries: 3 } }, // 4 pre-day, first by time
    { kind: 'set', atMs: d2, changes: { maxRetries: 4 } }, // 5 in-day, first instant
    { kind: 'set', atMs: d2 + DAY_MS, changes: { maxRetries: 5 } }, // 6 later day: ignored
    { kind: 'event', atMs: d2 + DAY_MS - 0.5, event: crash }, // 7 in-day, last
  ];

  it('splits pre-day sets from in-day patches, sorted stably by time', () => {
    const { preDay, inDay } = partitionPatches(patches, 2);
    expect(preDay).toEqual([patches[4], patches[1]]);
    expect(inDay).toEqual([patches[5], patches[0], patches[2], patches[7]]);
  });

  it('returns copies, so state never aliases the caller', () => {
    const { preDay } = partitionPatches(patches, 2);
    expect(preDay[0]).not.toBe(patches[4]);
    (preDay[0] as { changes: { maxRetries: number } }).changes.maxRetries = 99;
    expect((patches[4] as { changes: { maxRetries: number } }).changes.maxRetries).toBe(3);
  });

  it('rejects non-finite times', () => {
    expect(() => partitionPatches([{ kind: 'event', atMs: NaN, event: crash }], 0)).toThrow();
  });

  it('compares patch lists by content, not key order', () => {
    const a: Patch = { kind: 'set', atMs: 1, changes: { maxRetries: 1, retryBaseMs: 2 } };
    const b = { changes: { retryBaseMs: 2, maxRetries: 1 }, atMs: 1, kind: 'set' } as Patch;
    expect(samePatchList([a], [b])).toBe(true);
    expect(samePatchList([a], [{ ...a, atMs: 2 }])).toBe(false);
    expect(samePatchList([a], [])).toBe(false);
  });
});

describe('dayStartParams', () => {
  it("applies config.tunable, then pre-day 'set' patches in time order", () => {
    const d2 = dayStartMs(2);
    const tunable = { maxRetries: 0, retryBaseMs: 10 };
    const input = {
      config: { tunable },
      day: 2,
      patches: [
        { kind: 'set', atMs: d2 - 1, changes: { maxRetries: 2 } },
        { kind: 'set', atMs: 5, changes: { maxRetries: 1, retryBaseMs: 20 } },
        { kind: 'set', atMs: d2, changes: { maxRetries: 9 } },
      ],
    } as unknown as DayRunInput;
    expect(dayStartParams(input)).toEqual({ maxRetries: 2, retryBaseMs: 20 });
    expect(tunable).toEqual({ maxRetries: 0, retryBaseMs: 10 });
  });
});
