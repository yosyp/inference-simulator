// Tab 4 lesson assertions (00-build §7.3). Paired headless runs of Wednesday 07:00–11:30: every run
// shares the seed and the morning under affinity and differs only in the policy from 10:30, so
// arrivals and lengths are identical (keyed draws, K6). Measured over 10:30–11:30. The ranges in
// the comments are seeds 1–5 on the provisional calibration.

import { describe, expect, it } from 'vitest';
import type { TunableParams } from '../../engine/api.ts';
import { MINUTE_MS, dayOf, timeOfDayMs } from '../../engine/time.ts';
import type { Scenario } from '../schema.ts';
import {
  allOf,
  arrivedIn,
  entryToMomentWallS,
  hitRatesIn,
  isFinished,
  recordStats,
  replicaLoadImbalance,
  returningTurnTtft,
  runScenarioDay,
  sessionsMoved,
  win,
  type ScenarioDayResult,
} from '../testing/index.ts';
import { LESSON_MS, scenario } from './index.ts';

const N = scenario.preset.replicas;
const WINDOW = win(LESSON_MS, LESSON_MS + 60 * MINUTE_MS);
const inWindow = allOf(isFinished, arrivedIn(WINDOW));

const runs = new Map<string, ScenarioDayResult>();
/** The lesson day with `changes` applied at the moment, after the baseline switch (so they win). */
function run(changes: Partial<TunableParams> | null, s: Scenario = scenario): ScenarioDayResult {
  const key = `${JSON.stringify(changes)}|${s === scenario ? '' : JSON.stringify(s.sim.tunable)}`;
  let r = runs.get(key);
  if (!r) {
    r = runScenarioDay(s, {
      patches: changes ? [{ kind: 'set', atMs: LESSON_MS, changes }] : [],
      untilTimeOfDayMs: timeOfDayMs(WINDOW.toMs),
    });
    runs.set(key, r);
  }
  return r;
}
const roundRobin = () => run(null); // the baseline week
const affinity = () => run(scenario.namedFix!.changes);
const returningP50 = (r: ScenarioDayResult) => returningTurnTtft(r.records, inWindow).p50Ms;
const imbalance = (r: ScenarioDayResult) => replicaLoadImbalance(r, WINDOW).bucketRatio - 1;

describe('tab 4 · routing', { timeout: 20_000 }, () => {
  it('shows the tracked analyst moving replicas within 45 s of play from the entry point', () => {
    expect(dayOf(LESSON_MS)).toBeLessThanOrEqual(3); // Monday to Thursday (K2)
    expect(scenario.entry.atMs).toBeLessThan(LESSON_MS);
    expect(entryToMomentWallS(scenario)).toBeLessThanOrEqual(45); // 12 s

    // The canvas lists the tracked analyst's turns so far. By 45 s of play: returning turns that
    // stayed on one replica before the switch, then at least two that moved, each slower to first
    // token than any before. (Seed 4: 32–60 ms before; 573 and 824 ms after.)
    const r = roundRobin();
    const until = scenario.entry.atMs + 45_000 * scenario.entry.speed;
    const mine = r.records.filter(
      (q) =>
        q.analyst === r.trackedAnalyst &&
        q.turn >= 2 &&
        q.arriveMs >= scenario.entry.atMs - 2 * MINUTE_MS &&
        q.arriveMs < until,
    );
    const ttft = (q: (typeof mine)[number]) => q.firstTokenMs - q.arriveMs;
    const before = mine.filter((q) => q.arriveMs < LESSON_MS).map(ttft);
    const moved = mine.filter((q) => q.arriveMs >= LESSON_MS && q.replica !== q.prevReplica);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(moved.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...moved.map(ttft))).toBeGreaterThan(3 * Math.max(...before));
  });

  it('round-robin scatters returning turns and loses their history; affinity keeps them warm', () => {
    const rr = roundRobin();
    const aff = affinity();
    // About 1 − 1/N of sessions' next turns land on the other replica (concept 3).
    const moved = sessionsMoved(rr.records, LESSON_MS).fraction;
    expect(moved).toBeGreaterThan(1 - 1 / N - 0.1);
    expect(moved).toBeLessThan(1 - 1 / N + 0.1);
    expect(sessionsMoved(aff.records, LESSON_MS).moved).toBe(0);
    // Returning-turn hit rate: affinity 0.82–0.875, round-robin 0.50–0.57.
    expect(hitRatesIn(aff, WINDOW).returning).toBeGreaterThanOrEqual(0.75);
    expect(hitRatesIn(rr, WINDOW).returning).toBeLessThanOrEqual(1 / N + 0.1);
    // Returning-turn TTFT p50: 2.5–2.9× affinity's.
    expect(returningP50(rr)).toBeGreaterThanOrEqual(2 * returningP50(aff));
  });

  it('affinity leaves the replicas less even than least-outstanding, which is no faster', () => {
    const lo = run({ routingPolicy: 'leastOutstanding' });
    const aff = affinity();
    // Busiest replica over the mean, minus 1: about 4× least-outstanding's.
    expect(imbalance(aff)).toBeGreaterThan(2 * imbalance(lo));
    // Least-outstanding balances load but scatters conversations as round-robin does.
    expect(returningP50(lo)).toBeGreaterThanOrEqual(2 * returningP50(aff));
  });

  it('barely matters for single-turn requests (c1)', () => {
    // Mean turns 1 from the morning, with 4× the sessions so requests/s stays near the lesson's.
    const c1: Scenario = {
      ...scenario,
      sim: {
        ...scenario.sim,
        tunable: { ...scenario.sim.tunable, turnsPerSessionMean: 1, loadMultiplier: 4 },
      },
    };
    const rr = recordStats(run(null, c1).records, 'ttft', inWindow);
    const aff = recordStats(run(scenario.namedFix!.changes, c1).records, 'ttft', inWindow);
    expect(rr.count).toBeGreaterThan(1_000);
    expect(Math.abs(rr.p50Ms - aff.p50Ms)).toBeLessThanOrEqual(0.1 * aff.p50Ms);
  });
});
