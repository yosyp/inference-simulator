// The load module behind the real router (E7), with a stub standing in for the replicas (E5).

import { describe, expect, it } from 'vitest';
import type { DayRunInput, TunableParams } from '../api.ts';
import { createDayRunner } from '../core/index.ts';
import { OUTCOME } from '../results.ts';
import { routerModule } from '../router/index.ts';
import { sharedModule } from '../shared/index.ts';
import { loadModule } from './module.ts';
import { drawMessageTokens, drawOutputTokens } from './script.ts';
import {
  TEST_DAY,
  arrivals,
  bySession,
  ends,
  stubServer,
  testConfig,
  testInput,
  type StubPolicy,
} from './testkit.ts';

function simulate(policy: StubPolicy, input: DayRunInput) {
  const modules = [sharedModule, loadModule, routerModule, stubServer(policy, 'dispatched')];
  const run = createDayRunner(modules, { assertEveryEvent: true }).createDayRun(input);
  run.advance(run.dayEndMs);
  run.assertInvariants();
  return run;
}

const config = (tunable: Partial<TunableParams>) =>
  testConfig(
    { analystsPerReplica: 15 },
    // Live signals: no refresh event every second, which the per-event invariant checks would slow.
    { timeoutToFirstTokenMs: null, signalRefreshMs: 0, ...tunable },
  );

describe('with the router (E7)', () => {
  it('routing policies change where and when turns run, never the scripts', () => {
    const served = new Map<string, number>();
    // Replica 1 is 30× slower, so the policy changes latencies and the coherence rule kicks in.
    const policy: StubPolicy = (r) => {
      served.set(`${r.params.routingPolicy}/${r.id}`, r.replica);
      return {
        firstTokenAfterMs: 500,
        endAfterMs: r.replica === 0 ? 2_000 : 60_000,
        outcome: OUTCOME.finished,
      };
    };
    const seed = config({}).seed;
    const results = (['roundRobin', 'sessionAffinity', 'leastOutstanding'] as const).map(
      (routingPolicy) => {
        const run = simulate(policy, testInput(config({ routingPolicy })));
        const list = arrivals(run.state);
        for (const reqs of bySession(list).values()) {
          for (let i = 1; i < reqs.length; i++) {
            const prev = served.get(`${routingPolicy}/${reqs[i - 1]!.id}`);
            expect(reqs[i]!.prevReplica).toBe(prev);
          }
        }
        const scripts = list
          .map((a) => {
            const m = drawMessageTokens(seed, TEST_DAY, a.session, a.turn, 150, 0.8);
            const o = drawOutputTokens(seed, TEST_DAY, a.session, a.turn, 300, 0.7, 4096);
            expect(a.output).toBe(o);
            return `${a.session}/${a.turn}/${m}/${o}`;
          })
          .sort();
        return { scripts, times: list.map((a) => a.arriveMs) };
      },
    );
    expect(results[0]!.scripts.length).toBeGreaterThan(150);
    expect(results[1]!.scripts).toEqual(results[0]!.scripts);
    expect(results[2]!.scripts).toEqual(results[0]!.scripts);
    expect(results[1]!.times).not.toEqual(results[0]!.times);
  });

  it('router rejects under admission control feed retries and abandonment', () => {
    const policy: StubPolicy = () => ({
      firstTokenAfterMs: 1_000,
      endAfterMs: 120_000,
      outcome: OUTCOME.finished,
    });
    const input = testInput(
      config({ admissionLimitPerReplica: 2, retryPolicy: 'exponential', maxRetries: 2 }),
    );
    const run = simulate(policy, input);
    const end = ends(run.state);
    const list = arrivals(run.state);
    const rejected = list.filter((a) => end.get(a.id)?.[0] === OUTCOME.rejected);
    expect(run.state.router.stats.rejectedByCap).toBe(rejected.length);
    expect(rejected.length).toBeGreaterThan(20);
    expect(run.state.load.stats.retries).toBeGreaterThan(20);
    expect(run.state.shared.meters.fleet.abandonedSessions).toBeGreaterThan(0);
    expect(run.state.shared.meters.fleet.abandonedSessions).toBe(run.state.load.stats.abandoned);
    // Every rejected attempt that had retries left came back, as a new request.
    for (const reqs of bySession(list).values()) {
      for (const a of reqs) {
        if (end.get(a.id)?.[0] !== OUTCOME.rejected || a.attempt === 2) continue;
        expect(reqs.some((b) => b.turn === a.turn && b.attempt === a.attempt + 1)).toBe(true);
      }
    }
  });

  it('a timeout during the router overhead is ended by the router and retried', () => {
    const policy: StubPolicy = () => ({
      firstTokenAfterMs: 10,
      endAfterMs: 100,
      outcome: OUTCOME.finished,
    });
    const cfg = {
      ...config({ timeoutToFirstTokenMs: 1_000, retryPolicy: 'fixed', retryBaseMs: 500 }),
      routerOverheadMs: 5_000,
      analystsPerReplica: 3,
    };
    const run = simulate(policy, testInput(cfg));
    const end = ends(run.state);
    const list = arrivals(run.state);
    expect(list.length).toBeGreaterThan(10);
    for (const a of list) expect(end.get(a.id)).toEqual([OUTCOME.timedOut, a.arriveMs + 1_000]);
    expect(run.state.e6stub.cancels).toEqual([]);
    expect(run.state.router.stats.cancelledAtRouter).toBe(list.length);
    expect(run.state.load.stats.abandoned).toBe(run.state.load.stats.sessions);
  });
});
