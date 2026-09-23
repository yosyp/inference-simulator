import { describe, expect, it } from 'vitest';
import raw from '../../benchmarks/derived/calibration.json';
import type { DayRunInput, SimConfig } from './api.ts';
import { parseCalibration } from './calibration.ts';
import { runHeadless, runHeadlessDay } from './headless.ts';
import {
  ENGINE_MODULES,
  detailFor,
  engine,
  pickTrackedAnalyst,
  plannedTurnTimes,
  sessionPlan,
} from './index.ts';
import { DAY_MS, HOUR_MS, simMs, type DayIndex } from './time.ts';

const calibration = parseCalibration(raw);

function config(replicas: number, analysts = 40): SimConfig {
  return {
    seed: 11,
    replicas,
    analystsPerReplica: analysts,
    shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
    diurnal: {
      knots: [
        [7 * HOUR_MS, 0.3],
        [10.5 * HOUR_MS, 1],
        [17 * HOUR_MS, 0],
      ],
      dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
    },
    sessionsPerAnalystPerDay: 3,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 64,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 800,
      turnsPerSessionMean: 4,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 90_000,
      timeoutToFirstTokenMs: 60_000,
      retryPolicy: 'exponential',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 3,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

function input(c: SimConfig, day: DayIndex, patches: DayRunInput['patches'] = []): DayRunInput {
  return { config: c, calibration, day, patches, trackedAnalyst: null, detail: 'tracked' };
}

describe('engine assembly', () => {
  it('wires the modules in the 00-build order', () => {
    expect(ENGINE_MODULES.map((m) => m.name)).toEqual([
      'shared',
      'load',
      'router',
      'replica',
      'failure',
      'metrics',
    ]);
  });

  it('keeps full records for 1 GPU and 2 replicas only (K28)', () => {
    expect([1, 2, 4, 8].map((replicas) => detailFor({ replicas }))).toEqual([
      'all',
      'all',
      'tracked',
      'tracked',
    ]);
  });

  it('checkpoint, restore, and advance equal an uninterrupted day', () => {
    const c = config(2);
    const a = engine.createDayRun(input(c, 1));
    a.advance(simMs(1, 10));
    const cp = a.checkpoint();
    a.advance(simMs(1, 12));
    const b = engine.restoreDayRun(input(c, 1), cp);
    b.advance(simMs(1, 12));
    b.assertInvariants();
    expect(b.checkpoint().state).toEqual(a.checkpoint().state);
  });
});

describe('tracked analyst', () => {
  const c = config(3, 60);
  const moment = simMs(2, 10, 30);

  it('planned turn times reproduce every planned session end', () => {
    const inp = input(c, 2);
    const plan = sessionPlan(inp);
    expect(plan.length).toBeGreaterThan(100);
    for (const s of plan) {
      const times = plannedTurnTimes(inp, s, c.tunable.thinkTimeMedianMs);
      expect(times).not.toBeNull();
      expect(times!.length).toBe(s.turns);
    }
  });

  it("'fixed' returns its analyst; 'spansMoment' a session spanning the moment with turns after it", () => {
    expect(pickTrackedAnalyst({ rule: 'fixed', analyst: 42 }, input(c, 0))).toBe(42);
    const rule = { rule: 'spansMoment', momentMs: moment, minTurnsAfter: 2 } as const;
    const picked = pickTrackedAnalyst(rule, input(c, 0));
    expect(picked).not.toBeNull();
    const inp = input(c, 2);
    const ok = sessionPlan(inp).some((s) => {
      const times = plannedTurnTimes(inp, s, c.tunable.thinkTimeMedianMs)!;
      return (
        s.analyst === picked &&
        s.startMs <= moment &&
        moment <= s.plannedEndMs &&
        times.filter((t) => t > moment).length >= 2
      );
    });
    expect(ok).toBe(true);
    // Deterministic, and keyed by the seed.
    expect(pickTrackedAnalyst(rule, input(c, 0))).toBe(picked);
    const other = { ...c, seed: 12 };
    expect(pickTrackedAnalyst(rule, input(other, 0))).not.toBe(picked);
  });

  it('falls back to the best spanning session, then to the next session to start', () => {
    const inp = input(c, 2);
    const strict = { rule: 'spansMoment', momentMs: moment, minTurnsAfter: 10_000 } as const;
    expect(pickTrackedAnalyst(strict, inp)).not.toBeNull();
    const night = { rule: 'spansMoment', momentMs: simMs(2, 3), minTurnsAfter: 1 } as const;
    const first = [...sessionPlan(inp)].sort((a, b) => a.startMs - b.startMs)[0]!;
    expect(pickTrackedAnalyst(night, inp)).toBe(first.analyst);
  });
});

describe('headless runs', () => {
  const c = config(2);

  it('runs a day in chunks from its morning, with the rollup at its end', () => {
    let wall = 0;
    const r = runHeadless({ config: c, calibration, days: 3, tracked: 5, now: () => (wall += 1) });
    expect(r.trackedAnalyst).toBe(5);
    const d = r.days[0]!;
    expect(d.day).toBe(3);
    expect(d.chunks[0]!.fromMs).toBe(3 * DAY_MS);
    for (let i = 1; i < d.chunks.length; i++)
      expect(d.chunks[i]!.fromMs).toBe(d.chunks[i - 1]!.toMs);
    expect(d.chunks.at(-1)!.toMs).toBe(4 * DAY_MS);
    expect(d.chunks[0]!.requests.scope).toBe('all');
    expect(d.rollup).toHaveLength(2);
    expect(d.rollup!.reduce((s, x) => s + x.requestsServed, 0)).toBeGreaterThan(0);
    expect(r.speed).toBe(r.simMs / r.wallMs);
    expect(d.chunkWallMs).toHaveLength(d.chunks.length);
  });

  it('stops early, runs a range in order, and resolves a scenario rule', () => {
    const r = runHeadless({
      config: c,
      calibration,
      days: [4, 1],
      untilTimeOfDayMs: 9 * HOUR_MS,
      keepChunks: false,
      detail: 'tracked',
      tracked: { rule: 'spansMoment', momentMs: simMs(2, 10, 30), minTurnsAfter: 1 },
    });
    expect(r.days.map((d) => d.day)).toEqual([4, 1]);
    for (const d of r.days) {
      expect(d.rollup).toBeNull();
      expect(d.chunks).toEqual([]);
      expect(d.run.nowMs).toBe(d.day * DAY_MS + 9 * HOUR_MS);
      expect(d.chunkWallMs.length).toBeGreaterThan(0);
    }
    expect(r.trackedAnalyst).not.toBeNull();
    expect(Number.isNaN(r.speed)).toBe(true);
  });

  it('rejects a chunk size that is not a multiple of histBucketMs', () => {
    expect(() => runHeadlessDay({ config: c, calibration, chunkMs: 90_000 }, 0, null)).toThrow(
      /multiple/,
    );
  });
});
