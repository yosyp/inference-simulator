import { describe, expect, it } from 'vitest';
import type { DayCheckpoint } from '../engine/api.ts';
import { HOUR_MS, MINUTE_MS, simMs, type DayIndex } from '../engine/time.ts';
import {
  covers,
  estimateBytes,
  insertCheckpoint,
  latestAtOrBefore,
  thin,
  type StoredCheckpoint,
} from './checkpoints.ts';
import { enforceBudget } from './days.ts';
import { checkpointDue, createGrid, nextChunkEnd } from './grid.ts';
import { newDaySlot, type Active } from './state.ts';
import { smallConfig } from './testkit.ts';

const g = createGrid(smallConfig(1));
const D = 2 as DayIndex;

describe('chunk grid', () => {
  it('uses the G1 sizes on the fixture shift', () => {
    expect(g).toEqual({
      chunkMs: 5 * MINUTE_MS,
      firstChunkMs: MINUTE_MS,
      activeStartMs: 7 * HOUR_MS,
      activeEndMs: 17 * HOUR_MS,
      focusCheckpointMs: 15 * MINUTE_MS,
      otherCheckpointMs: HOUR_MS,
    });
  });

  it('sends each night as one chunk and the shift on a 5-minute grid', () => {
    expect(nextChunkEnd(g, D, simMs(D, 0))).toBe(simMs(D, 7));
    expect(nextChunkEnd(g, D, simMs(D, 7))).toBe(simMs(D, 7, 5));
    expect(nextChunkEnd(g, D, simMs(D, 10, 44))).toBe(simMs(D, 10, 45));
    expect(nextChunkEnd(g, D, simMs(D, 16, 55))).toBe(simMs(D, 17));
    expect(nextChunkEnd(g, D, simMs(D, 17))).toBe(simMs(3, 0));
  });

  it('cuts the first chunk after a fork to a minute, and the chunk reaching the focus time', () => {
    expect(nextChunkEnd(g, D, simMs(D, 10, 40), { first: true, targetMs: null })).toBe(
      simMs(D, 10, 41),
    );
    expect(
      nextChunkEnd(g, D, simMs(D, 10, 25), { first: false, targetMs: simMs(D, 10, 28, 5) }),
    ).toBe(simMs(D, 10, 29));
    // A target outside the chunk changes nothing.
    expect(nextChunkEnd(g, D, simMs(D, 10, 25), { first: false, targetMs: simMs(D, 11) })).toBe(
      simMs(D, 10, 30),
    );
  });

  it('places checkpoints where a step reaches an interval mark inside the shift', () => {
    const q = 15 * MINUTE_MS;
    expect(checkpointDue(g, D, simMs(D, 10, 40), simMs(D, 10, 45), q)).toBe(true);
    expect(checkpointDue(g, D, simMs(D, 10, 45), simMs(D, 10, 50), q)).toBe(false);
    expect(checkpointDue(g, D, simMs(D, 10, 44), simMs(D, 10, 46), q)).toBe(true);
    // The morning is free, and nothing after the shift.
    expect(checkpointDue(g, D, simMs(D, 0), simMs(D, 7), q)).toBe(false);
    expect(checkpointDue(g, D, simMs(D, 17), simMs(3, 0), q)).toBe(false);
    expect(checkpointDue(g, D, simMs(D, 10, 40), simMs(D, 10, 45), null)).toBe(false);
  });
});

function fakeCp(atMs: number, bytes = 1_000): StoredCheckpoint {
  return { cp: { day: D, atMs, state: null }, bytes };
}

describe('checkpoint storage', () => {
  it('finds the latest at or before a time, inserts in order, and keeps the first at a time', () => {
    let list: StoredCheckpoint[] = [];
    const cp = (atMs: number, tag: number): DayCheckpoint => ({ day: D, atMs, state: { tag } });
    list = insertCheckpoint(list, cp(simMs(D, 9), 1));
    list = insertCheckpoint(list, cp(simMs(D, 8), 2));
    list = insertCheckpoint(list, cp(simMs(D, 9), 3));
    expect(list.map((s) => s.cp.state)).toEqual([{ tag: 2 }, { tag: 1 }]);
    expect(latestAtOrBefore(list, simMs(D, 8, 59))?.atMs).toBe(simMs(D, 8));
    expect(latestAtOrBefore(list, simMs(D, 9))?.atMs).toBe(simMs(D, 9));
    expect(latestAtOrBefore(list, simMs(D, 7))).toBeNull();
    expect(covers(list, simMs(D, 9), 5 * MINUTE_MS)).toBe(true);
    expect(covers(list, simMs(D, 9, 15), 5 * MINUTE_MS)).toBe(false);
  });

  it('thins a focus day to the first checkpoint at each hour', () => {
    const list = [7.25, 7.5, 7.75, 8, 8.25, 8.5, 8.75, 9, 9.25].map((h) => fakeCp(simMs(D, h)));
    const kept = thin(list, D, HOUR_MS, 5 * MINUTE_MS).map((s) => s.cp.atMs);
    expect(kept).toEqual([simMs(D, 8), simMs(D, 9)]);
    expect(thin(list, D, null, 5 * MINUTE_MS)).toEqual([]);
  });

  it('estimates typed arrays by their bytes', () => {
    const est = estimateBytes({ a: new Float64Array(1000), b: [1, 2, 3], c: new Map([[1, 'x']]) });
    expect(est).toBeGreaterThan(8000);
    expect(est).toBeLessThan(9000);
  });

  it('evicts from the day farthest from the focus, keeping the rest spread out', () => {
    const days = [0, 1, 2, 3, 4].map((d) => newDaySlot(d as DayIndex));
    const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16];
    days[1]!.checkpoints = hours.map((h) => fakeCp(simMs(1, h)));
    days[0]!.checkpoints = [];
    days[3]!.checkpoints = hours.map((h) => fakeCp(simMs(3, h)));
    days[4]!.checkpoints = hours.map((h) => fakeCp(simMs(4, h)));
    days[2]!.checkpoints = hours.map((h) => fakeCp(simMs(2, h)));
    const h = {
      budgetBytes: 12_000,
      setup: { grid: g },
      run: { focusDay: 2, days },
    } as unknown as Active;
    enforceBudget(h);
    // The focus day is never touched. Friday goes first (farthest; later on a tie with Monday),
    // then Thursday before Tuesday: the day before the focus may still hold the playhead.
    expect(days[2]!.checkpoints).toHaveLength(9);
    expect(days[4]!.checkpoints).toHaveLength(0);
    expect(days[1]!.checkpoints).toHaveLength(9);
    // Thursday lost 6 of 9 and keeps the rest spread: no gap longer than 4 hours.
    const thu = days[3]!.checkpoints.map((s) => (s.cp.atMs - simMs(3, 0)) / HOUR_MS);
    expect(thu).toHaveLength(3);
    const gaps = thu.map((t, i) => t - (i > 0 ? thu[i - 1]! : 7));
    expect(Math.max(...gaps, 17 - thu.at(-1)!)).toBeLessThanOrEqual(4);
  });
});
