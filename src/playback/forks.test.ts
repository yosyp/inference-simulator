import { describe, expect, it } from 'vitest';
import { DAY_MS, WEEK_MS, simMs } from '../engine/time.ts';
import { makeFixtureChunk } from '../fixtures/chunks.ts';
import {
  applyCutToRanges,
  chunkDataStartMs,
  classifyOlderChunk,
  cutMsFor,
  dayInvalidated,
  type CutRecord,
} from './forks.ts';

const wedCut = (lasting: boolean): CutRecord => ({
  revision: 1,
  day: 2,
  cutMs: simMs(2, 10, 30),
  lasting,
});

describe('fork cut rule', () => {
  it('floors the fork time to the histogram bucket', () => {
    expect(cutMsFor(simMs(2, 10, 30, 45), 60_000)).toBe(simMs(2, 10, 30));
    expect(cutMsFor(simMs(2, 10, 30), 60_000)).toBe(simMs(2, 10, 30));
  });

  it('removes the rest of the day, or the rest of the week when lasting', () => {
    const week = [{ fromMs: 0, toMs: WEEK_MS }];
    expect(applyCutToRanges(week, wedCut(false))).toEqual([
      { fromMs: 0, toMs: simMs(2, 10, 30) },
      { fromMs: 3 * DAY_MS, toMs: WEEK_MS },
    ]);
    expect(applyCutToRanges(week, wedCut(true))).toEqual([{ fromMs: 0, toMs: simMs(2, 10, 30) }]);
  });

  it('marks rollups stale only for days a newer fork touches', () => {
    const cuts = [wedCut(false)];
    expect(dayInvalidated(cuts, 0, 2)).toBe(true);
    expect(dayInvalidated(cuts, 0, 3)).toBe(false);
    expect(dayInvalidated([wedCut(true)], 0, 3)).toBe(true);
    expect(dayInvalidated([wedCut(true)], 0, 1)).toBe(false);
    expect(dayInvalidated(cuts, 1, 2)).toBe(false);
  });
});

describe('classifyOlderChunk', () => {
  const opts = { replicas: 1 };
  const chunk = (from: number, to: number) => makeFixtureChunk(opts, from, to);

  it('drops data at or after the cut on the fork day', () => {
    const c = chunk(simMs(2, 10, 30), simMs(2, 10, 45));
    expect(classifyOlderChunk([wedCut(false)], 0, c)).toEqual({ action: 'drop' });
  });

  it('keeps data before the cut and on days the fork does not touch', () => {
    const before = chunk(simMs(2, 10), simMs(2, 10, 15));
    expect(classifyOlderChunk([wedCut(false)], 0, before)).toEqual({ action: 'add', recut: [] });
    const thursday = chunk(simMs(3, 9), simMs(3, 9, 15));
    expect(classifyOlderChunk([wedCut(false)], 0, thursday)).toEqual({ action: 'add', recut: [] });
    expect(classifyOlderChunk([wedCut(true)], 0, thursday)).toEqual({ action: 'drop' });
    const monday = chunk(simMs(0, 9), simMs(0, 9, 15));
    expect(classifyOlderChunk([wedCut(true)], 0, monday)).toEqual({ action: 'add', recut: [] });
  });

  it('adds a chunk straddling the cut and re-applies the cut', () => {
    const c = chunk(simMs(2, 10, 15), simMs(2, 10, 45));
    expect(classifyOlderChunk([wedCut(false)], 0, c)).toEqual({
      action: 'add',
      recut: [wedCut(false)],
    });
  });

  it('ignores forks at or before the data revision', () => {
    const c = chunk(simMs(2, 10, 30), simMs(2, 10, 45));
    expect(classifyOlderChunk([wedCut(false)], 1, c)).toEqual({ action: 'add', recut: [] });
  });

  it('counts complete buckets that start before fromMs', () => {
    const c = chunk(simMs(2, 10, 30), simMs(2, 10, 45));
    c.fromMs = simMs(2, 10, 30, 30);
    expect(chunkDataStartMs(c)).toBe(simMs(2, 10, 30));
  });
});
