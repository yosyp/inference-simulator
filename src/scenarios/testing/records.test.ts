import { describe, expect, it } from 'vitest';
import { OUTCOME } from '../../engine/results.ts';
import { simMs } from '../../engine/time.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import {
  arrivedIn,
  recordStats,
  returningTurnHitRate,
  returningTurnTtft,
  sessionsMoved,
} from './records.ts';
import type { RequestRecord } from './run.ts';
import { entryToMomentWallS, parsePatchArg, parseTimeOfDay } from './scenario.ts';

function rec(p: Partial<RequestRecord>): RequestRecord {
  return {
    id: 0,
    session: 0,
    analyst: 0,
    turn: 1,
    attempt: 0,
    replica: 0,
    prevReplica: -1,
    arriveMs: 0,
    dispatchMs: 0,
    firstTokenMs: 100,
    endMs: 1_000,
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
    preemptions: 0,
    outcome: OUTCOME.finished,
    ...p,
  };
}

describe('record helpers', () => {
  it('recordStats: exact TTFT, TPOT, and E2E with a filter', () => {
    const rs = [1, 2, 3, 4].map((i) =>
      rec({ arriveMs: i * 1000, firstTokenMs: i * 1000 + i * 10 }),
    );
    const s = recordStats(rs, 'ttft');
    expect(s).toEqual({ count: 4, meanMs: 25, p50Ms: 25, p99Ms: expect.closeTo(39.7, 5) });
    expect(recordStats(rs, 'ttft', arrivedIn({ fromMs: 3000, toMs: 5000 })).meanMs).toBe(35);
    expect(recordStats([rec({ firstTokenMs: 100, endMs: 1000 })], 'tpot').meanMs).toBe(100);
    expect(recordStats([rec({ outcome: OUTCOME.timedOut })], 'e2e').count).toBe(0);
  });

  it('returning-turn hit rate and TTFT skip first turns and undispatched requests', () => {
    const rs = [
      rec({ turn: 1, cachedTokens: 0, promptTokens: 1000 }),
      rec({ turn: 2, cachedTokens: 80, promptTokens: 100, firstTokenMs: 50 }),
      rec({ turn: 3, cachedTokens: 20, promptTokens: 100, firstTokenMs: 150 }),
      rec({ turn: 2, replica: -1, outcome: OUTCOME.rejected, firstTokenMs: NaN }),
    ];
    expect(returningTurnHitRate(rs)).toEqual({ hitRate: 0.5, requests: 2 });
    expect(returningTurnTtft(rs).p50Ms).toBe(100);
  });

  it('sessionsMoved takes each session’s first finished returning turn after the time', () => {
    const rs = [
      // Session 1: failed on its old replica, then the retry moved; counts as moved.
      rec({
        session: 1,
        turn: 3,
        prevReplica: 0,
        replica: 0,
        arriveMs: 10,
        outcome: OUTCOME.failed,
      }),
      rec({ session: 1, turn: 3, attempt: 1, prevReplica: 0, replica: 2, arriveMs: 20 }),
      // Session 2 stayed; its later turn that moved doesn't count.
      rec({ session: 2, turn: 2, prevReplica: 1, replica: 1, arriveMs: 30 }),
      rec({ session: 2, turn: 3, prevReplica: 1, replica: 3, arriveMs: 40 }),
      // Before the time, and a first turn: ignored.
      rec({ session: 3, turn: 2, prevReplica: 1, replica: 3, arriveMs: 1 }),
      rec({ session: 4, turn: 1, replica: 3, arriveMs: 50 }),
    ];
    expect(sessionsMoved(rs, 5)).toEqual({ sessions: 2, moved: 1, fraction: 0.5 });
  });
});

describe('scenario helpers', () => {
  it('entryToMomentWallS divides the gap by the entry speed', () => {
    const s = fixtureScenarios()[0]!;
    const t = { ...s, entry: { atMs: simMs(2, 10), speed: 60 } };
    t.lessonMoment = { ...s.lessonMoment, atMs: simMs(2, 10, 30) };
    expect(entryToMomentWallS(t)).toBe(30);
  });

  it('parses --patch and --until arguments', () => {
    const base = fixtureScenarios()[0]!.sim.tunable;
    expect(parsePatchArg('routingPolicy=sessionAffinity', base)).toEqual({
      routingPolicy: 'sessionAffinity',
    });
    expect(parsePatchArg('loadMultiplier=1.5', base)).toEqual({ loadMultiplier: 1.5 });
    expect(parsePatchArg('admissionLimitPerReplica=null', base)).toEqual({
      admissionLimitPerReplica: null,
    });
    expect(() => parsePatchArg('routingPolicy=random', base)).toThrow(/one of/);
    expect(() => parsePatchArg('nope=1', base)).toThrow(/Unknown/);
    expect(parseTimeOfDay('09:30')).toBe(simMs(0, 9, 30));
  });
});
