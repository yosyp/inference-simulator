import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch, RetryPolicy } from '../api.ts';
import { OUTCOME } from '../results.ts';
import { REQUEST_KIND } from '../shared/index.ts';
import { HOUR_MS, dayStartMs } from '../time.ts';
import { EXTRA_SESSION_BASE, SESSION_END } from './ids.ts';
import {
  drawMessageTokens,
  drawOutputTokens,
  drawThinkMs,
  drawTurns,
  retryDelayMs,
} from './script.ts';
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
const SEED = testConfig().seed;

function simulate(policy: StubPolicy, input: DayRunInput = testInput()) {
  const run = runner(policy).createDayRun(input);
  run.advance(run.dayEndMs);
  run.assertInvariants();
  return run;
}

const msg = (session: number, turn: number) =>
  drawMessageTokens(SEED, TEST_DAY, session, turn, 150, 0.8);
const out = (session: number, turn: number) =>
  drawOutputTokens(SEED, TEST_DAY, session, turn, 300, 0.7, 4096);
const think = (session: number, turn: number) =>
  drawThinkMs(SEED, TEST_DAY, session, turn, 90_000, 3);

/** First attempts only, by session. */
function firstAttempts(list: readonly Arrival[]): Map<number, Arrival[]> {
  return bySession(list.filter((a) => a.attempt === 0 && a.kind === REQUEST_KIND.turn));
}

describe('turns', () => {
  it('turn N+1 goes at turn N arrival + think time, or when turn N ends if later', () => {
    // Odd sessions take 400 s per turn, far over the 90 s median think time.
    const policy: StubPolicy = (r) => ({
      firstTokenAfterMs: 500,
      endAfterMs: r.session % 2 === 1 ? 400_000 : 2_000,
      outcome: OUTCOME.finished,
    });
    const run = simulate(policy);
    const end = ends(run.state);
    let waited = 0;
    let thought = 0;
    for (const [session, turns] of firstAttempts(arrivals(run.state))) {
      turns.forEach((a, i) => expect(a.turn).toBe(i + 1));
      for (let i = 0; i + 1 < turns.length; i++) {
        const a = turns[i]!;
        const endMs = end.get(a.id)![1];
        const planned = a.arriveMs + think(session, a.turn);
        expect(turns[i + 1]!.arriveMs).toBe(Math.max(planned, endMs));
        if (endMs > planned) waited++;
        else thought++;
      }
    }
    expect(waited).toBeGreaterThan(10);
    expect(thought).toBeGreaterThan(10);
  });

  it('prompt = system prompt + successful history + new message; prevReplica is the last turn’s', () => {
    const run = simulate(fixedService(2_000, 300));
    const sessions = firstAttempts(arrivals(run.state));
    expect(sessions.size).toBeGreaterThan(40);
    for (const [session, turns] of sessions) {
      let history = 0;
      for (const a of turns) {
        expect(a.sys).toBe(800);
        expect(a.prompt).toBe(800 + history + msg(session, a.turn));
        expect(a.output).toBe(out(session, a.turn));
        expect(a.prevReplica).toBe(a.turn === 1 ? -1 : session % 2);
        history += msg(session, a.turn) + out(session, a.turn);
      }
    }
  });

  it('failed attempts never enter history, and a sync reject retries through a new request', () => {
    // Turn 2 fails once (after 3 s), is rejected once at the router, then finishes.
    const policy: StubPolicy = (r) => {
      if (r.turn === 2 && r.attempt === 0)
        return { firstTokenAfterMs: 1_000, endAfterMs: 3_000, outcome: OUTCOME.failed };
      if (r.turn === 2 && r.attempt === 1)
        return { firstTokenAfterMs: null, endAfterMs: null, outcome: OUTCOME.rejected, sync: true };
      return { firstTokenAfterMs: 200, endAfterMs: 1_000, outcome: OUTCOME.finished };
    };
    const run = simulate(
      policy,
      testInput(testConfig({}, { retryPolicy: 'fixed', retryBaseMs: 5_000 })),
    );
    const end = ends(run.state);
    let checked = 0;
    for (const [session, reqs] of bySession(arrivals(run.state))) {
      const t2 = reqs.filter((a) => a.turn === 2);
      const t3 = reqs.find((a) => a.turn === 3);
      if (t2.length === 0) continue;
      expect(t2.map((a) => a.attempt)).toEqual([0, 1, 2]);
      expect(new Set(t2.map((a) => a.id)).size).toBe(3);
      expect(new Set(t2.map((a) => a.prompt)).size).toBe(1);
      expect(t2.every((a) => a.prevReplica === session % 2)).toBe(true);
      expect(t2[1]!.arriveMs).toBe(end.get(t2[0]!.id)![1] + 5_000);
      expect(end.get(t2[1]!.id)).toEqual([OUTCOME.rejected, t2[1]!.arriveMs]);
      expect(t2[2]!.arriveMs).toBe(t2[1]!.arriveMs + 5_000);
      if (t3) {
        expect(t3.prompt).toBe(t2[0]!.prompt + out(session, 2) + msg(session, 3));
        // Think time runs from the successful attempt's arrival.
        expect(t3.arriveMs).toBe(
          Math.max(t2[2]!.arriveMs + think(session, 2), end.get(t2[2]!.id)![1]),
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(run.state.load.stats.retries).toBe(
      2 *
        [...bySession(arrivals(run.state)).values()].filter((r) => r.some((a) => a.turn === 2))
          .length,
    );
  });

  it('no session ever has two requests outstanding', () => {
    const policy: StubPolicy = (r) => ({
      firstTokenAfterMs: 100,
      endAfterMs: (r.session % 7) * 60_000 + 1_000,
      outcome: r.session % 3 === 0 && r.attempt === 0 ? OUTCOME.failed : OUTCOME.finished,
    });
    const run = simulate(policy);
    const end = ends(run.state);
    for (const reqs of bySession(arrivals(run.state)).values()) {
      for (let i = 1; i < reqs.length; i++) {
        expect(reqs[i]!.arriveMs).toBeGreaterThanOrEqual(end.get(reqs[i - 1]!.id)![1]);
      }
    }
  });

  it('never sends a turn at or after the shift end', () => {
    const cfg = testConfig(
      { shift: { startMs: 7 * HOUR_MS, endMs: 12 * HOUR_MS + 30 * 60_000 } },
      { thinkTimeMedianMs: 20 * 60_000, turnsPerSessionMean: 10 },
    );
    const run = simulate(fixedService(1_000), testInput(cfg));
    const list = arrivals(run.state);
    expect(list.every((a) => a.arriveMs < START + cfg.shift.endMs)).toBe(true);
    // Some sessions were cut short by the shift's end and still count as completed.
    let cut = 0;
    for (const [session, reqs] of firstAttempts(list)) {
      const last = reqs[reqs.length - 1]!;
      if (reqs.length === drawTurns(SEED, TEST_DAY, session, 10)) continue;
      const thinkMs = drawThinkMs(SEED, TEST_DAY, session, last.turn, 20 * 60_000, 3);
      expect(Math.max(last.arriveMs + thinkMs, last.arriveMs + 1_000)).toBeGreaterThanOrEqual(
        START + cfg.shift.endMs,
      );
      cut++;
    }
    expect(cut).toBeGreaterThan(5);
    expect(run.state.load.stats.abandoned).toBe(0);
    expect(run.state.load.stats.completed).toBe(run.state.load.stats.sessions);
  });

  it('keeps prompt + output within maxModelLen and ends sessions whose context is full', () => {
    const run = simulate(
      fixedService(1_000),
      testInput(testConfig({}, { turnsPerSessionMean: 30, thinkTimeMedianMs: 5_000 }), [], {
        maxModelLen: 3_000,
      }),
    );
    const list = arrivals(run.state);
    expect(list.every((a) => a.prompt + a.output <= 3_000)).toBe(true);
    // Sessions stop early only when the next message plus one output token can't fit.
    let full = 0;
    for (const [session, reqs] of firstAttempts(list)) {
      if (reqs.length === drawTurns(SEED, TEST_DAY, session, 30)) continue;
      const last = reqs[reqs.length - 1]!;
      expect(last.prompt + last.output).toBeGreaterThanOrEqual(3_000 - 1);
      full++;
    }
    expect(full).toBeGreaterThan(20);
    expect(run.state.load.stats.completed).toBe(run.state.load.stats.sessions);
  });
});

describe('client retries and abandonment', () => {
  const failTwice: StubPolicy = (r) =>
    r.attempt < 2
      ? { firstTokenAfterMs: null, endAfterMs: 700, outcome: OUTCOME.rejected }
      : { firstTokenAfterMs: 100, endAfterMs: 1_000, outcome: OUTCOME.finished };

  for (const policy of ['immediate', 'fixed', 'exponential', 'fullJitter'] as RetryPolicy[]) {
    it(`${policy}: each retry is a new request after the policy's delay`, () => {
      const cfg = testConfig({}, { retryPolicy: policy, retryBaseMs: 2_000, retryCapMs: 3_000 });
      const run = simulate(failTwice, testInput(cfg));
      const end = ends(run.state);
      let n = 0;
      for (const reqs of bySession(arrivals(run.state)).values()) {
        const turns = new Set(reqs.map((a) => a.turn));
        for (const turn of turns) {
          const attempts = reqs.filter((a) => a.turn === turn);
          expect(attempts.map((a) => a.attempt)).toEqual([0, 1, 2]);
          for (let k = 0; k < 2; k++) {
            const a = attempts[k]!;
            const delay = retryDelayMs(policy, 2_000, 3_000, SEED, TEST_DAY, a.session, a.turn, k);
            expect(attempts[k + 1]!.arriveMs).toBe(end.get(a.id)![1] + delay);
            expect(attempts[k + 1]!.id).not.toBe(a.id);
            n++;
          }
        }
      }
      expect(n).toBeGreaterThan(100);
      expect(run.state.load.stats.abandoned).toBe(0);
    });
  }

  it('abandons the session when retries run out, and counts it', () => {
    const alwaysFail: StubPolicy = () => ({
      firstTokenAfterMs: 200,
      endAfterMs: 1_000,
      outcome: OUTCOME.failed,
    });
    for (const [retryPolicy, maxRetries, attempts] of [
      ['exponential', 2, 3],
      ['none', 5, 1],
    ] as const) {
      const run = simulate(alwaysFail, testInput(testConfig({}, { retryPolicy, maxRetries })));
      const sessions = bySession(arrivals(run.state));
      expect(sessions.size).toBe(run.state.load.stats.sessions);
      for (const reqs of sessions.values()) {
        expect(reqs.map((a) => [a.turn, a.attempt])).toEqual(
          Array.from({ length: attempts }, (_, k) => [1, k]),
        );
      }
      expect(run.state.shared.meters.fleet.abandonedSessions).toBe(sessions.size);
      const ended = run.state.e6stub.sessionEnds;
      expect(ended.length).toBe(2 * sessions.size);
      for (let i = 1; i < ended.length; i += 2) expect(ended[i]).toBe(SESSION_END.abandoned);
      expect(run.state.load.sessions.count).toBe(0);
    }
  });
});

describe('client timeout to first token', () => {
  const hold: StubPolicy = () => ({
    firstTokenAfterMs: null,
    endAfterMs: null,
    outcome: OUTCOME.finished,
  });

  it('fires at arrival + timeout, cancels through the holder, and retries', () => {
    const cfg = testConfig(
      {},
      { timeoutToFirstTokenMs: 10_000, retryPolicy: 'fixed', retryBaseMs: 1_000, maxRetries: 1 },
    );
    const run = simulate(hold, testInput(cfg));
    const end = ends(run.state);
    const list = arrivals(run.state);
    expect(run.state.e6stub.cancels.length).toBe(list.length);
    for (const reqs of bySession(list).values()) {
      expect(reqs.map((a) => a.attempt)).toEqual([0, 1]);
      for (const a of reqs) expect(end.get(a.id)).toEqual([OUTCOME.timedOut, a.arriveMs + 10_000]);
      expect(reqs[1]!.arriveMs).toBe(reqs[0]!.arriveMs + 11_000);
    }
    expect(run.state.shared.meters.fleet.abandonedSessions).toBe(bySession(list).size);
  });

  it('is disarmed by the first token, including one exactly at the deadline', () => {
    for (const ttft of [5_000, 10_000]) {
      const policy: StubPolicy = () => ({
        firstTokenAfterMs: ttft,
        endAfterMs: 100_000,
        outcome: OUTCOME.finished,
      });
      const run = simulate(policy, testInput(testConfig({}, { timeoutToFirstTokenMs: 10_000 })));
      expect(run.state.e6stub.cancels).toEqual([]);
      expect([...ends(run.state).values()].every(([o]) => o === OUTCOME.finished)).toBe(true);
    }
  });

  it('never fires when the timeout is null; a request can be held all day', () => {
    const run = simulate(hold, testInput(testConfig({}, { timeoutToFirstTokenMs: null })));
    expect(run.state.e6stub.cancels).toEqual([]);
    expect(run.state.load.sessions.count).toBe(run.state.load.stats.sessions);
  });

  it('grows its tables when thousands of requests are in flight, then drains them', () => {
    // Every request is held until 12:30, when a crash fails them all; retries then finish.
    const policy: StubPolicy = (r) =>
      r.attempt === 0
        ? { firstTokenAfterMs: null, endAfterMs: null, outcome: OUTCOME.finished }
        : { firstTokenAfterMs: 10, endAfterMs: 100, outcome: OUTCOME.finished };
    const patches: Patch[] = [
      { kind: 'event', atMs: START + 12.5 * HOUR_MS, event: { type: 'crash', replica: 0 } },
    ];
    const cfg = testConfig(
      { analystsPerReplica: 250 },
      { timeoutToFirstTokenMs: null, turnsPerSessionMean: 1 },
    );
    const run = runner(policy, false).createDayRun(testInput(cfg, patches));
    run.advance(START + 12.5 * HOUR_MS);
    run.assertInvariants();
    const held = run.state.load.stats.sessions;
    expect(held).toBeGreaterThan(1_300);
    expect(run.state.load.sessions.capacity).toBeGreaterThanOrEqual(held);
    expect(run.state.shared.requests.capacity).toBeGreaterThanOrEqual(held);
    expect(run.state.load.recOfSlot.length).toBeGreaterThanOrEqual(
      run.state.shared.requests.capacity,
    );
    run.advance(run.dayEndMs);
    run.assertInvariants();
    expect(run.state.load.sessions.count).toBe(0);
    expect(run.state.load.stats.retries).toBe(held);
    expect(run.state.load.stats.completed).toBe(held);
  });

  it('uses the timeout in effect at each request’s arrival', () => {
    const at = START + 10 * HOUR_MS;
    const patches: Patch[] = [{ kind: 'set', atMs: at, changes: { timeoutToFirstTokenMs: 3_000 } }];
    const cfg = testConfig({}, { timeoutToFirstTokenMs: 20_000, maxRetries: 0 });
    const run = simulate(hold, testInput(cfg, patches));
    const end = ends(run.state);
    for (const a of arrivals(run.state)) {
      expect(end.get(a.id)![1] - a.arriveMs).toBe(a.arriveMs < at ? 20_000 : 3_000);
    }
  });
});

describe('injected events', () => {
  it('extraRequest sends one single-turn request with its own session id', () => {
    const t1 = START + 9 * HOUR_MS;
    const t2 = START + 11 * HOUR_MS;
    const patches: Patch[] = [
      {
        kind: 'event',
        atMs: t1,
        event: {
          type: 'extraRequest',
          analyst: 'tracked',
          promptTokens: 24_000,
          outputTokens: 200,
        },
      },
      {
        kind: 'event',
        atMs: t2,
        event: { type: 'extraRequest', analyst: 3, promptTokens: 500_000, outputTokens: 50 },
      },
    ];
    const base = simulate(fixedService(4_000), testInput(testConfig(), [], { trackedAnalyst: 7 }));
    const run = simulate(
      fixedService(4_000),
      testInput(testConfig(), patches, { trackedAnalyst: 7, maxModelLen: 131_072 }),
    );
    const extras = arrivals(run.state).filter((a) => a.kind === REQUEST_KIND.extra);
    expect(extras.map(({ id: _id, ...a }) => a)).toEqual([
      {
        session: EXTRA_SESSION_BASE,
        analyst: 7,
        turn: 1,
        attempt: 0,
        kind: REQUEST_KIND.extra,
        arriveMs: t1,
        prompt: 24_000,
        sys: 800,
        output: 200,
        prevReplica: -1,
      },
      {
        session: EXTRA_SESSION_BASE + 1,
        analyst: 3,
        turn: 1,
        attempt: 0,
        kind: REQUEST_KIND.extra,
        arriveMs: t2,
        prompt: 131_071,
        sys: 800,
        output: 1,
        prevReplica: -1,
      },
    ]);
    // Organic sessions are untouched, and extras are not sessions.
    const organic = (r: typeof run) =>
      arrivals(r.state)
        .filter((a) => a.kind === REQUEST_KIND.turn)
        .map(({ id: _id, ...a }) => a);
    expect(organic(run)).toEqual(organic(base));
    expect(run.state.load.stats.sessions).toBe(base.state.load.stats.sessions);
    expect(run.state.load.stats.extras).toBe(2);
    expect(
      run.state.e6stub.sessionEnds.filter((_, i) => i % 2 === 0 && _ >= EXTRA_SESSION_BASE),
    ).toEqual([]);
  });

  it("extraRequest for 'tracked' with no tracked analyst picks a keyed analyst", () => {
    const patches: Patch[] = [
      {
        kind: 'event',
        atMs: START + 9 * HOUR_MS,
        event: { type: 'extraRequest', analyst: 'tracked', promptTokens: 100, outputTokens: 10 },
      },
    ];
    const pick = () =>
      arrivals(simulate(fixedService(1), testInput(testConfig(), patches)).state).find(
        (a) => a.kind === REQUEST_KIND.extra,
      )!;
    const a = pick();
    expect(a.analyst).toBeLessThan(20);
    expect(pick().analyst).toBe(a.analyst);
    expect(a.sys).toBe(100);
    expect(a.prompt).toBe(100);
  });

  it('extra requests time out and retry like any other request', () => {
    const patches: Patch[] = [
      {
        kind: 'event',
        atMs: START + 9 * HOUR_MS,
        event: { type: 'extraRequest', analyst: 1, promptTokens: 30_000, outputTokens: 10 },
      },
    ];
    const policy: StubPolicy = (r) =>
      r.kind === REQUEST_KIND.extra
        ? { firstTokenAfterMs: null, endAfterMs: null, outcome: OUTCOME.finished }
        : { firstTokenAfterMs: 10, endAfterMs: 100, outcome: OUTCOME.finished };
    const cfg = testConfig(
      {},
      { timeoutToFirstTokenMs: 5_000, maxRetries: 2, retryPolicy: 'immediate' },
    );
    const run = simulate(policy, testInput(cfg, patches));
    const extras = arrivals(run.state).filter((a) => a.kind === REQUEST_KIND.extra);
    expect(extras.map((a) => a.attempt)).toEqual([0, 1, 2]);
    expect(run.state.shared.meters.fleet.abandonedSessions).toBe(0);
    expect(run.state.load.stats.abandoned).toBe(1);
  });
});
