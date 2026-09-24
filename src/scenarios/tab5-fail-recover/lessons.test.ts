// Tab 5 lesson assertions (00-build §7.3; 01 §5 concepts 7–11). Runs Wednesday headless from its
// morning to 09:18, a minute past the rejoin, three times: the baseline (session affinity, mod-N),
// consistent hashing, and least-outstanding. The last two are set from the day's start: switching
// the hash scheme mid-morning remaps sessions itself, which would blur the pre-crash baseline.
//
// The replacement host is back ~2 minutes after the crash, so the damage is concentrated in the
// three minutes that follow it; the windows below cover that stretch, compared with the 15 minutes
// before the crash.

import { describe, expect, it } from 'vitest';
import type { TunableParams } from '../../engine/api.ts';
import { replicaSeries } from '../../engine/results.ts';
import { HOUR_MS, MINUTE_MS, SECOND_MS, dayOf, timeOfDayMs } from '../../engine/time.ts';
import {
  after,
  before,
  entryToMomentWallS,
  hitRatesIn,
  readyAtOrAfter,
  runScenarioDay,
  scalarIn,
  sessionsMoved,
  setPatchAtDayStart,
  ttftStatsInWindow,
  type ScenarioDayResult,
} from '../testing/index.ts';
import { CRASHED_REPLICA, CRASH_MS, scenario } from './index.ts';

const UNTIL = timeOfDayMs(CRASH_MS) + 3 * MINUTE_MS;
const MARK_DOWN_MS = CRASH_MS + scenario.sim.detectionDelayMs;
const PRE = before(CRASH_MS, 15 * MINUTE_MS);
const OUTAGE = after(CRASH_MS, 3 * MINUTE_MS);
const TIMEOUT = 30_000;

const runs = new Map<string, ScenarioDayResult>();
/** The lesson day to 09:18, with `changes` in effect from the day's start. */
function run(name: string, changes: Partial<TunableParams> = {}): ScenarioDayResult {
  let r = runs.get(name);
  if (!r) {
    const patches = [setPatchAtDayStart(dayOf(CRASH_MS), changes)];
    r = runScenarioDay(scenario, { patches, untilTimeOfDayMs: UNTIL });
    runs.set(name, r);
  }
  return r;
}
const modN = () => run('modN');
const consistent = () => run('consistent', { hashScheme: 'consistent' });
const leastOutstanding = () => run('leastOutstanding', { routingPolicy: 'leastOutstanding' });

/** Sessions moved by the crash: sessions served before it, at their first turn after mark-down. */
function movedByCrash(r: ScenarioDayResult, rejoinMs: number) {
  const before = new Set(r.records.filter((x) => x.dispatchMs < CRASH_MS).map((x) => x.session));
  return sessionsMoved(
    r.records,
    MARK_DOWN_MS,
    (x) => before.has(x.session) && x.arriveMs < rejoinMs,
  );
}

/** Fleet prefill tokens per second (cache hits excluded, recompute included). */
function prefillPerS(r: ScenarioDayResult, w: { fromMs: number; toMs: number }): number {
  return scalarIn(r, 'prefillTokens', w) / ((w.toMs - w.fromMs) / SECOND_MS);
}

describe('tab 5: fail and recover', () => {
  it(
    'opens paused two minutes before a Wednesday-morning crash (K2, K16, K30, §7.3)',
    () => {
      const day = dayOf(scenario.lessonMoment.atMs);
      expect(day).toBeGreaterThanOrEqual(0);
      expect(day).toBeLessThanOrEqual(3);
      expect(scenario.entry.atMs).toBeLessThan(scenario.lessonMoment.atMs);
      // K30: Server B enters by 09:30, so the first frame stays within P1's 3 s.
      expect(timeOfDayMs(scenario.entry.atMs)).toBeLessThanOrEqual(9.5 * HOUR_MS);
      expect(entryToMomentWallS(scenario)).toBeLessThanOrEqual(45);
      // The whole outage (mark-down, weight load, engine init, rejoin) plays within 45 s too.
      const rejoinMs = readyAtOrAfter(modN(), CRASHED_REPLICA, CRASH_MS);
      expect(rejoinMs).not.toBeNull();
      expect((rejoinMs! - scenario.entry.atMs) / scenario.entry.speed / SECOND_MS).toBeLessThan(45);
      expect(scenario.baselinePatches).toContainEqual({
        kind: 'event',
        atMs: scenario.lessonMoment.atMs,
        event: scenario.trigger.patch.kind === 'event' ? scenario.trigger.patch.event : null,
      });
    },
    TIMEOUT,
  );

  it(
    'mod-N remaps about 7/8 of sessions; consistent hashing about 1/8 (concept 10)',
    () => {
      const rejoin = readyAtOrAfter(modN(), CRASHED_REPLICA, CRASH_MS)!;
      const m = movedByCrash(modN(), rejoin);
      const c = movedByCrash(consistent(), rejoin);
      console.log(
        `sessions moved: mod-N ${m.moved}/${m.sessions} = ${m.fraction.toFixed(3)}, ` +
          `consistent ${c.moved}/${c.sessions} = ${c.fraction.toFixed(3)}`,
      );
      expect(m.sessions).toBeGreaterThan(200);
      expect(c.sessions).toBeGreaterThan(200);
      expect(m.fraction).toBeGreaterThanOrEqual(0.8);
      expect(c.fraction).toBeLessThanOrEqual(0.2);

      // The copy's tracked analyst: not on the crashed replica, yet moved by mod-N after mark-down
      // and again after the rejoin; left in place by consistent hashing.
      const movedTurns = (r: ScenarioDayResult) =>
        r.records.filter(
          (x) =>
            x.analyst === r.trackedAnalyst &&
            x.arriveMs >= CRASH_MS &&
            x.prevReplica >= 0 &&
            x.replica !== x.prevReplica,
        );
      const lastBefore = modN()
        .records.filter((x) => x.analyst === modN().trackedAnalyst && x.arriveMs < CRASH_MS)
        .sort((a, b) => a.arriveMs - b.arriveMs)
        .at(-1);
      expect(lastBefore).toBeDefined();
      expect(lastBefore!.replica).not.toBe(CRASHED_REPLICA);
      const moves = movedTurns(modN());
      expect(moves.some((x) => x.arriveMs < rejoin)).toBe(true);
      expect(moves.some((x) => x.arriveMs >= rejoin)).toBe(true);
      expect(consistent().trackedAnalyst).toBe(modN().trackedAnalyst);
      expect(movedTurns(consistent())).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    'losing 1 of 8 replicas costs far more than 1/8; less under consistent hashing (concepts 7–9)',
    () => {
      const m = modN();
      const c = consistent();
      const stats = (r: ScenarioDayResult) => {
        const pre = ttftStatsInWindow(r, PRE);
        const out = ttftStatsInWindow(r, OUTAGE);
        return {
          pre,
          out,
          meanRise: out.meanMs / pre.meanMs,
          p99Rise: out.p99Ms / pre.p99Ms,
          prefillRise: prefillPerS(r, OUTAGE) / prefillPerS(r, PRE),
          hitPre: hitRatesIn(r, PRE).returning,
          hitOut: hitRatesIn(r, OUTAGE).returning,
        };
      };
      const sm = stats(m);
      const sc = stats(c);
      for (const [name, s] of [
        ['mod-N', sm],
        ['consistent', sc],
      ] as const) {
        console.log(
          `${name}: TTFT mean ${s.pre.meanMs.toFixed(0)} → ${s.out.meanMs.toFixed(0)} ms ` +
            `(${s.meanRise.toFixed(2)}×), p99 ${s.pre.p99Ms.toFixed(0)} → ${s.out.p99Ms.toFixed(0)} ms ` +
            `(${s.p99Rise.toFixed(2)}×), prefill ${s.prefillRise.toFixed(2)}×, ` +
            `returning hit ${s.hitPre.toFixed(2)} → ${s.hitOut.toFixed(2)}`,
        );
      }
      // Before the crash, affinity keeps most histories: returning turns mostly hit the cache.
      expect(sm.hitPre).toBeGreaterThanOrEqual(0.7);
      // Mod-N: 7 survivors carry the traffic (8/7 each) and re-prefill most sessions' histories.
      // The fleet's prefill work more than doubles, though traffic is unchanged and capacity fell 1/8.
      expect(sm.prefillRise).toBeGreaterThanOrEqual(1.8);
      expect(sm.hitOut).toBeLessThanOrEqual(sm.hitPre - 0.15);
      // Chart 1: TTFT mean roughly doubles over the three minutes; p99 rises too, by less.
      expect(sm.meanRise).toBeGreaterThanOrEqual(1.8);
      expect(sm.p99Rise).toBeGreaterThanOrEqual(1.3);
      // Consistent hashing moves only the crashed replica's sessions: much less recompute, and a
      // TTFT-mean rise at most half of mod-N's.
      expect(sc.prefillRise).toBeLessThanOrEqual(sm.prefillRise - 0.6);
      expect(sc.out.meanMs - sc.pre.meanMs).toBeLessThanOrEqual(
        0.5 * (sm.out.meanMs - sm.pre.meanMs),
      );
      expect(sc.hitOut).toBeGreaterThan(sm.hitOut + 0.1);
    },
    TIMEOUT,
  );

  it(
    'least-outstanding: a black hole until mark-down, then a cold burst on rejoin (K34, concept 11)',
    () => {
      const r = leastOutstanding();
      const crashed = replicaSeries(CRASHED_REPLICA);
      // K34: the crashed replica fails requests at once, so its outstanding count stays 0 and it
      // looks least busy until it is marked down: it draws nearly every request in between.
      const hole = { fromMs: CRASH_MS, toMs: MARK_DOWN_MS };
      const holeShare = scalarIn(r, 'dispatched', hole, crashed) / scalarIn(r, 'dispatched', hole);
      // The rejoin: Ready with an empty cache and an outstanding count of 0, so it draws every
      // request until the router's next load reading (signalRefreshMs, 1 s) shows it busy. With the
      // measured calibration decode is faster and the survivors hold fewer requests (~6 each), so
      // after that reading the rejoined replica's burst already exceeds them and the burst ends: it
      // took 6 of 10 requests in 2 s, all 6 in the first second. The window is that first reading.
      const rejoinMs = readyAtOrAfter(r, CRASHED_REPLICA, CRASH_MS)!;
      const dispatchedIn = (fromMs: number, toMs: number) =>
        r.records.filter((x) => x.dispatchMs >= fromMs && x.dispatchMs < toMs);
      const burst = dispatchedIn(rejoinMs, rejoinMs + scenario.sim.tunable.signalRefreshMs);
      const burstShare = burst.filter((x) => x.replica === CRASHED_REPLICA).length / burst.length;
      // Returning turns it serves in its first 30 s: none finds its history there, only the
      // shared system prompt. Elsewhere in the fleet some do.
      const sys = scenario.sim.tunable.systemPromptTokens;
      const historyHit = (onRejoined: boolean) => {
        const turns = dispatchedIn(rejoinMs, rejoinMs + 30 * SECOND_MS).filter(
          (x) => x.turn >= 2 && (x.replica === CRASHED_REPLICA) === onRejoined,
        );
        return turns.filter((x) => x.cachedTokens > sys).length / turns.length;
      };
      console.log(
        `least-outstanding: crashed replica drew ${(holeShare * 100).toFixed(0)}% before mark-down; ` +
          `rejoined drew ${(burstShare * 100).toFixed(0)}% of the first 1 s (${burst.length} requests); ` +
          `history hits on it ${historyHit(true).toFixed(2)} vs fleet ${historyHit(false).toFixed(2)}`,
      );
      // Measured: 94% before mark-down; 6 of 6 requests in the first second after the rejoin.
      expect(holeShare).toBeGreaterThanOrEqual(0.8);
      expect(burst.length).toBeGreaterThanOrEqual(4);
      expect(burstShare).toBeGreaterThanOrEqual(0.8);
      expect(historyHit(true)).toBeLessThanOrEqual(0.05);
      expect(historyHit(false)).toBeGreaterThan(historyHit(true));
    },
    TIMEOUT,
  );
});
