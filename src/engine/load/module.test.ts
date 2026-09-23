// Whole-day properties of the load module: pairing (K6), sessionPlan, spikes, workload shifts,
// determinism, and checkpoint/restore/fork (K21).

import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch, SessionSummary } from '../api.ts';
import { advanceInSteps, digestState } from '../core/index.ts';
import { OUTCOME } from '../results.ts';
import { REQUEST_KIND } from '../shared/index.ts';
import { HOUR_MS, MINUTE_MS, dayStartMs } from '../time.ts';
import { sessionPlan } from './plan.ts';
import { drawMessageTokens, drawOutputTokens, drawThinkMs, drawTurns } from './script.ts';
import {
  TEST_DAY,
  arrivals,
  bySession,
  ends,
  fixedService,
  runner,
  testConfig,
  testInput,
  type Arrival,
  type StubPolicy,
} from './testkit.ts';

const START = dayStartMs(TEST_DAY);

function simulate(policy: StubPolicy, input: DayRunInput, assertEveryEvent = true) {
  const run = runner(policy, assertEveryEvent).createDayRun(input);
  run.advance(run.dayEndMs);
  run.assertInvariants();
  return run;
}

/** Arrivals without the request id, which depends on creation order across sessions. */
function strip(list: readonly Arrival[]) {
  return list.map(({ id: _id, ...rest }) => rest);
}

/**
 * (session, turn, message, output, think) for each first attempt, from what the requests carried:
 * the message is the prompt growth beyond the previous turn, and think is the keyed draw, checked
 * against the arrivals by the coherence rule (next = max(arrival + think, end)).
 */
function scriptTuples(
  list: readonly Arrival[],
  endOf: Map<number, [number, number]>,
  seed: number,
) {
  const tuples: string[] = [];
  for (const [session, reqs] of bySession(list.filter((a) => a.kind === REQUEST_KIND.turn))) {
    const firsts = reqs.filter((a) => a.attempt === 0);
    let prev: Arrival | null = null;
    for (const a of firsts) {
      const message = prev ? a.prompt - prev.prompt - prev.output : a.prompt - a.sys;
      const think = drawThinkMs(seed, TEST_DAY, session, a.turn, 90_000, 3);
      const next = firsts[a.turn];
      if (next) expect(next.arriveMs).toBe(Math.max(a.arriveMs + think, endOf.get(a.id)![1]));
      tuples.push(`${session}/${a.turn}/${message}/${a.output}/${think}`);
      prev = a;
    }
  }
  return tuples.sort();
}

describe('pairing (K6)', () => {
  it('router and client parameters never change sessions, turns, lengths, or think times', () => {
    // The stub's latency depends on the routing policy, as a real router's would.
    const policy: StubPolicy = (r) => {
      const slow = r.params.routingPolicy === 'leastOutstanding';
      return {
        firstTokenAfterMs: 1_000,
        endAfterMs: slow ? 30_000 + (r.session % 5) * 60_000 : 2_000,
        outcome: OUTCOME.finished,
      };
    };
    const cfg = testConfig({ analystsPerReplica: 20 });
    const a = simulate(policy, testInput(cfg));
    const b = simulate(
      policy,
      testInput({
        ...cfg,
        tunable: {
          ...cfg.tunable,
          routingPolicy: 'leastOutstanding',
          hashScheme: 'consistent',
          timeoutToFirstTokenMs: null,
          retryPolicy: 'fullJitter',
          maxRetries: 7,
          admissionLimitPerReplica: 50,
        },
      }),
    );
    const la = arrivals(a.state);
    const lb = arrivals(b.state);
    expect(strip(la)).not.toEqual(strip(lb)); // later turns really did move
    const ta = scriptTuples(la, ends(a.state), cfg.seed);
    expect(ta.length).toBeGreaterThan(200);
    expect(scriptTuples(lb, ends(b.state), cfg.seed)).toEqual(ta);
  });

  it('a mid-day loadMultiplier increase adds sessions and leaves existing ones unchanged', () => {
    const at = START + 10 * HOUR_MS;
    const cfg = testConfig({ analystsPerReplica: 20 });
    const patches: Patch[] = [{ kind: 'set', atMs: at, changes: { loadMultiplier: 2 } }];
    const a = bySession(arrivals(simulate(fixedService(3_000, 500), testInput(cfg)).state));
    const b = bySession(
      arrivals(simulate(fixedService(3_000, 500), testInput(cfg, patches)).state),
    );
    let before = 0;
    let after = 0;
    for (const [session, reqs] of a) {
      expect(strip(b.get(session)!)).toEqual(strip(reqs));
      if (reqs[0]!.arriveMs < at) before++;
      else after++;
    }
    const added = [...b.values()].filter((r) => !a.has(r[0]!.session));
    expect(before).toBeGreaterThan(30);
    expect(added.every((r) => r[0]!.arriveMs >= at)).toBe(true);
    expect(added.length).toBeGreaterThan(after * 0.6);
  });
});

describe('loadSpike', () => {
  it('multiplies session starts for its duration only, keeping every baseline session', () => {
    const from = START + 9 * HOUR_MS;
    const to = from + HOUR_MS;
    const cfg = testConfig({ analystsPerReplica: 200 });
    const patches: Patch[] = [
      {
        kind: 'event',
        atMs: from,
        event: { type: 'loadSpike', multiplier: 3, durationMs: HOUR_MS },
      },
    ];
    const base = simulate(fixedService(1_000), testInput(cfg), false);
    const spiked = simulate(fixedService(1_000), testInput(cfg, patches), false);
    const starts = (r: typeof base) =>
      [...bySession(arrivals(r.state)).values()].map((reqs) => reqs[0]!);
    const inWindow = (a: Arrival) => a.arriveMs >= from && a.arriveMs < to;
    const s0 = starts(base);
    const s1 = starts(spiked);
    const ids1 = new Set(s1.map((a) => a.session));
    expect(s0.every((a) => ids1.has(a.session))).toBe(true);
    expect(strip(s1.filter((a) => !inWindow(a)))).toEqual(strip(s0.filter((a) => !inWindow(a))));
    const ratio = s1.filter(inWindow).length / s0.filter(inWindow).length;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.5);
    expect(spiked.state.load.spikeProduct).toBe(1);
  });
});

describe('workloadShift', () => {
  it('gives sessions starting in its window the shifted workload, and leaves the rest alone', () => {
    const from = START + 9 * HOUR_MS;
    const to = from + 30 * MINUTE_MS;
    const cfg = testConfig({ analystsPerReplica: 40 });
    const long = { turnsPerSessionMean: 8, messageTokensMedian: 600, outputTokensMedian: 1_200 };
    const shift = (durationMs: number): Patch[] => [
      { kind: 'event', atMs: from, event: { type: 'workloadShift', changes: long, durationMs } },
    ];
    const base = bySession(arrivals(simulate(fixedService(1_000), testInput(cfg)).state));
    const shifted = bySession(
      arrivals(simulate(fixedService(1_000), testInput(cfg, shift(to - from))).state),
    );
    expect([...shifted.keys()]).toEqual([...base.keys()]); // session starts never move
    let inside = 0;
    for (const [session, reqs] of shifted) {
      const first = reqs[0]!;
      if (!(first.arriveMs >= from && first.arriveMs < to)) {
        expect(strip(reqs)).toEqual(strip(base.get(session)!));
        continue;
      }
      inside++;
      const { seed } = cfg;
      const message = drawMessageTokens(seed, TEST_DAY, session, 1, 600, cfg.messageTokensSigma);
      const output = drawOutputTokens(
        seed,
        TEST_DAY,
        session,
        1,
        1_200,
        cfg.outputTokensSigma,
        cfg.outputTokensMax,
      );
      expect([first.prompt - first.sys, first.output]).toEqual([message, output]);
      expect(strip(reqs)).not.toEqual(strip(base.get(session)!));
    }
    expect(inside).toBeGreaterThan(10);
    for (const bad of [0, -1, NaN]) {
      expect(() => sessionPlan(testInput(cfg, shift(bad)))).toThrow(RangeError);
      expect(() => simulate(fixedService(1_000), testInput(cfg, shift(bad)))).toThrow(RangeError);
    }
  });
});

describe('sessionPlan', () => {
  it('matches the simulated arrivals exactly when service time is zero', () => {
    const cfg = testConfig(
      {
        analystsPerReplica: 30,
        shift: { startMs: 7 * HOUR_MS, endMs: 14 * HOUR_MS },
        diurnal: {
          knots: [
            [7 * HOUR_MS, 0.2],
            [10 * HOUR_MS, 1],
            [14 * HOUR_MS, 0.6],
          ],
          dayMultipliers: [1, 1, 1.2, 1, 1],
        },
      },
      { thinkTimeMedianMs: 10 * MINUTE_MS, turnsPerSessionMean: 6 },
    );
    const patches: Patch[] = [
      { kind: 'set', atMs: START - HOUR_MS, changes: { messageTokensMedian: 400 } },
      { kind: 'set', atMs: START + 10 * HOUR_MS, changes: { turnsPerSessionMean: 12 } },
      {
        kind: 'event',
        atMs: START + 10 * HOUR_MS + 30 * MINUTE_MS,
        event: {
          type: 'workloadShift',
          changes: {
            turnsPerSessionMean: 3,
            messageTokensMedian: 1_500,
            thinkTimeMedianMs: 60_000,
          },
          durationMs: 45 * MINUTE_MS,
        },
      },
      {
        kind: 'event',
        atMs: START + 11 * HOUR_MS,
        event: { type: 'loadSpike', multiplier: 2, durationMs: 30 * MINUTE_MS },
      },
      { kind: 'set', atMs: START + 12 * HOUR_MS, changes: { loadMultiplier: 1.5 } },
      {
        kind: 'event',
        atMs: START + 12 * HOUR_MS,
        event: { type: 'extraRequest', analyst: 2, promptTokens: 900, outputTokens: 9 },
      },
      {
        kind: 'event',
        atMs: START + 13 * HOUR_MS,
        event: { type: 'loadSpike', multiplier: 0, durationMs: 20 * HOUR_MS },
      },
    ];
    const input = testInput(cfg, patches, { maxModelLen: 6_000 });
    const plan = sessionPlan(input);
    const run = simulate(fixedService(0), input);
    const simulated: SessionSummary[] = [];
    for (const [session, reqs] of bySession(arrivals(run.state))) {
      if (reqs[0]!.kind !== REQUEST_KIND.turn) continue;
      const last = reqs[reqs.length - 1]!;
      expect(reqs.every((a, i) => a.turn === i + 1 && a.attempt === 0)).toBe(true);
      simulated.push({
        session,
        analyst: reqs[0]!.analyst,
        startMs: reqs[0]!.arriveMs,
        turns: reqs.length,
        plannedEndMs: last.arriveMs,
      });
    }
    expect(plan.length).toBeGreaterThan(80);
    expect(simulated).toEqual(plan);
    // Both bounds were exercised: some sessions stop at the shift's end, some at a full context.
    const cut = plan.filter((s) => s.turns < drawTurns(cfg.seed, TEST_DAY, s.session, 6));
    expect(cut.length).toBeGreaterThan(10);
    expect(plan.every((s) => s.plannedEndMs < START + cfg.shift.endMs)).toBe(true);
    expect(plan.some((s) => s.startMs >= START + 13 * HOUR_MS)).toBe(false);
  });
});

describe('determinism and checkpoints (K21)', () => {
  // Mixed behaviour: some requests hold until they time out, some fail once, the rest finish.
  const policy: StubPolicy = (r) => {
    if (r.session % 5 === 0 && r.attempt === 0)
      return { firstTokenAfterMs: null, endAfterMs: null, outcome: OUTCOME.finished };
    if (r.session % 5 === 1 && r.attempt === 0)
      return { firstTokenAfterMs: 100, endAfterMs: 4_000, outcome: OUTCOME.failed };
    return {
      firstTokenAfterMs: 700,
      endAfterMs: 5_000 + (r.session % 3) * 40_000,
      outcome: OUTCOME.finished,
    };
  };
  const cfg = testConfig(
    { analystsPerReplica: 15 },
    { timeoutToFirstTokenMs: 15_000, retryPolicy: 'fullJitter', retryBaseMs: 2_000 },
  );
  const patches: Patch[] = [
    {
      kind: 'event',
      atMs: START + 9 * HOUR_MS + 30 * MINUTE_MS,
      event: { type: 'extraRequest', analyst: 'tracked', promptTokens: 20_000, outputTokens: 100 },
    },
    {
      kind: 'event',
      atMs: START + 10 * HOUR_MS,
      event: { type: 'loadSpike', multiplier: 2, durationMs: 40 * MINUTE_MS },
    },
    // Active across the 10:15 checkpoints below.
    {
      kind: 'event',
      atMs: START + 10 * HOUR_MS + 5 * MINUTE_MS,
      event: {
        type: 'workloadShift',
        changes: { turnsPerSessionMean: 8, outputTokensMedian: 900 },
        durationMs: 30 * MINUTE_MS,
      },
    },
    {
      kind: 'set',
      atMs: START + 10 * HOUR_MS + 30 * MINUTE_MS,
      changes: { loadMultiplier: 1.5, systemPromptTokens: 1_200 },
    },
    { kind: 'event', atMs: START + 11 * HOUR_MS, event: { type: 'crash', replica: 0 } },
  ];
  const input = testInput(cfg, patches, { trackedAnalyst: 4 });

  it('gives identical runs for identical inputs, however the day is split', () => {
    const a = simulate(policy, input);
    const b = runner(policy).createDayRun(input);
    advanceInSteps(b, b.dayEndMs, 7 * MINUTE_MS);
    expect(digestState(b.state)).toBe(digestState(a.state));
    expect(a.state.load.stats.retries).toBeGreaterThan(20);
    expect(a.state.e6stub.cancels.length).toBeGreaterThan(5);
  });

  it('restores from checkpoints to the same end state', () => {
    const full = simulate(policy, input);
    const r = runner(policy);
    const run = r.createDayRun(input);
    for (const t of [9 * HOUR_MS, 10 * HOUR_MS + 15 * MINUTE_MS, 11 * HOUR_MS]) {
      run.advance(START + t);
      run.assertInvariants();
      const cp = run.checkpoint();
      const restored = r.restoreDayRun({ ...input, detail: 'tracked' }, cp);
      restored.advance(restored.dayEndMs);
      restored.assertInvariants();
      expect(digestState(restored.state)).toBe(digestState(full.state));
    }
  });

  it('a fork from a checkpoint equals a fresh run with the new patch', () => {
    const r = runner(policy);
    const run = r.createDayRun(input);
    run.advance(START + 10 * HOUR_MS + 15 * MINUTE_MS);
    const cp = run.checkpoint();
    const fork: Patch[] = [
      ...patches,
      {
        kind: 'set',
        atMs: START + 10 * HOUR_MS + 20 * MINUTE_MS,
        changes: { loadMultiplier: 3, retryPolicy: 'immediate' },
      },
      {
        kind: 'event',
        atMs: START + 10 * HOUR_MS + 20 * MINUTE_MS,
        event: { type: 'extraRequest', analyst: 1, promptTokens: 3_000, outputTokens: 10 },
      },
      {
        kind: 'event',
        atMs: START + 10 * HOUR_MS + 20 * MINUTE_MS,
        event: {
          type: 'workloadShift',
          changes: { messageTokensMedian: 700, thinkTimeMedianMs: 30_000 },
          durationMs: 25 * MINUTE_MS,
        },
      },
    ];
    const forked = r.restoreDayRun({ ...input, patches: fork }, cp);
    forked.advance(forked.dayEndMs);
    const fresh = simulate(policy, { ...input, patches: fork });
    expect(digestState(forked.state)).toBe(digestState(fresh.state));
    expect(fresh.state.load.stats.sessions).toBeGreaterThan(
      simulate(policy, input).state.load.stats.sessions,
    );
  });
});
