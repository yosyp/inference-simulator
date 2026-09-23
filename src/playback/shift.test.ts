import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, SECOND_MS, WEEK_MS, simMs } from '../engine/time.ts';
import { advancePlayhead, bufferingAt, inShift, playableAt, weekEndMs } from './shift.ts';

const shift = { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS };
const all = [{ fromMs: 0, toMs: WEEK_MS }];

describe('shift helpers', () => {
  it('knows the shift hours and the end of the week', () => {
    expect(inShift(simMs(1, 7), shift)).toBe(true);
    expect(inShift(simMs(1, 16, 59), shift)).toBe(true);
    expect(inShift(simMs(1, 17), shift)).toBe(false);
    expect(inShift(simMs(1, 6, 59), shift)).toBe(false);
    expect(inShift(WEEK_MS + 8 * HOUR_MS, shift)).toBe(false);
    expect(weekEndMs(shift)).toBe(simMs(4, 17));
  });

  it('snaps off-shift times to the next shift start', () => {
    expect(playableAt(simMs(1, 10), shift)).toBe(simMs(1, 10));
    expect(playableAt(simMs(1, 3), shift)).toBe(simMs(1, 7));
    expect(playableAt(simMs(1, 17), shift)).toBe(simMs(2, 7));
    expect(playableAt(simMs(1, 23), shift)).toBe(simMs(2, 7));
    expect(playableAt(-5, shift)).toBe(simMs(0, 7));
    expect(playableAt(simMs(4, 17), shift)).toBeNull();
    expect(playableAt(simMs(4, 22), shift)).toBeNull();
  });
});

describe('advancePlayhead', () => {
  it('moves by simulated time inside a shift', () => {
    expect(advancePlayhead(simMs(0, 9), 60 * SECOND_MS, shift, all)).toEqual({
      playheadMs: simMs(0, 9, 1),
      buffering: false,
      ended: false,
    });
  });

  it('skips the night and carries the remainder into the next shift', () => {
    const r = advancePlayhead(simMs(0, 16, 59, 59), 16 * SECOND_MS, shift, all);
    expect(r).toEqual({ playheadMs: simMs(1, 7, 0, 15), buffering: false, ended: false });
  });

  it('jumps from an off-shift time to the next shift start', () => {
    expect(advancePlayhead(simMs(2, 3), 0, shift, all).playheadMs).toBe(simMs(2, 7));
    expect(advancePlayhead(simMs(2, 20), 5_000, shift, all).playheadMs).toBe(simMs(3, 7, 0, 5));
  });

  it("stops at the end of Friday's shift", () => {
    expect(advancePlayhead(simMs(4, 16, 59), 10 * 60_000, shift, all)).toEqual({
      playheadMs: simMs(4, 17),
      buffering: false,
      ended: true,
    });
  });

  it('holds at the first uncomputed instant', () => {
    const computed = [{ fromMs: simMs(2, 0), toMs: simMs(2, 10, 30) }];
    expect(advancePlayhead(simMs(2, 10, 29), 5 * 60_000, shift, computed)).toEqual({
      playheadMs: simMs(2, 10, 30),
      buffering: true,
      ended: false,
    });
    // At the held instant, nothing moves until more is computed.
    expect(advancePlayhead(simMs(2, 10, 30), 60_000, shift, computed).playheadMs).toBe(
      simMs(2, 10, 30),
    );
  });

  it('does not need the night to be computed, only the next shift start', () => {
    const computed = [
      { fromMs: simMs(1, 0), toMs: simMs(1, 17) },
      { fromMs: simMs(2, 0), toMs: simMs(2, 8) },
    ];
    expect(advancePlayhead(simMs(1, 16, 59), 2 * 60_000, shift, computed).playheadMs).toBe(
      simMs(2, 7, 1),
    );
    const notYet = [{ fromMs: simMs(1, 0), toMs: DAY_MS * 2 }];
    expect(advancePlayhead(simMs(1, 16, 59), 2 * 60_000, shift, notYet)).toEqual({
      playheadMs: simMs(2, 7),
      buffering: true,
      ended: false,
    });
  });

  it('reports buffering only inside a shift', () => {
    expect(bufferingAt(simMs(2, 9), shift, [])).toBe(true);
    expect(bufferingAt(simMs(2, 3), shift, [])).toBe(false);
    expect(bufferingAt(simMs(2, 9), shift, all)).toBe(false);
  });
});
