// Request lifecycle at the replica: cancels in every state, crash and rejoin, dispatch to a replica
// that isn't Ready, and requests that could never run.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.provisional.json';
import { parseCalibration } from '../calibration.ts';
import { batch1TtftMs } from '../cost/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import { runScript, testConfig, withEngine, type HarnessOptions, type Script } from './harness.ts';

const cal = parseCalibration(raw);
const S = REQUEST_STATE;
const R = REPLICA_STATE;

function both(script: Script, options: HarnessOptions = {}, calibration = cal) {
  return [true, false].map((eventJumping) => {
    const h = runScript(calibration, script, {
      ...options,
      eventJumping,
      runner: { assertEveryEvent: true },
    });
    h.run.advance(h.run.dayEndMs);
    h.run.assertInvariants();
    const rep = h.run.state.replica.replicas[0]!;
    return { ...h, d: h.driver(), rep };
  });
}

describe('cancel (client timeout, K8) in every state', () => {
  it('while waiting: never admitted, holds nothing', () => {
    const config = testConfig({ engineOverrides: { maxNumSeqs: 1 } });
    const script = {
      requests: [
        { atMs: 0, promptTokens: 1_000, outputTokens: 200 },
        { atMs: 10, promptTokens: 1_000, outputTokens: 5, timeoutMs: 500 },
        { atMs: 20, promptTokens: 300, outputTokens: 5 },
      ],
    };
    for (const { d, rep } of both(script, { config })) {
      expect(d.outcome).toEqual([OUTCOME.finished, OUTCOME.timedOut, OUTCOME.finished]);
      expect(d.states[1]).toEqual([S.waiting, S.timedOut]);
      expect(d.endMs[1]).toBe(510);
      expect(d.outputDone[1]).toBe(0);
      expect(d.firstTokenMs[1]).toBeNaN();
      expect(d.firstTokenMs[2]).toBeGreaterThan(d.endMs[0]!);
      expect(rep.pool.referencedCount).toBe(0);
    }
  });

  it('during prefill: the chunk in flight is dropped, blocks are freed and stay cached', () => {
    const script = {
      requests: [
        { atMs: 0, session: 3, promptTokens: 20_000, outputTokens: 5, cancelAtMs: 50 },
        { atMs: 1, session: 4, promptTokens: 100, outputTokens: 5 },
      ],
    };
    for (const { d, rep, run } of both(script)) {
      expect(d.states[0]).toEqual([S.waiting, S.prefill, S.timedOut]);
      expect(d.outcome[1]).toBe(OUTCOME.finished);
      expect(rep.pool.referencedCount).toBe(0);
      // The first chunk (8,192 tokens) wasn't computed when the cancel came, so nothing is cached.
      expect(rep.pool.evictableCount).toBeGreaterThan(0); // request 1's blocks
      expect(run.state.shared.meters.replica.prefillTokens[0]).toBeGreaterThan(8_192);
    }
  });

  it('during decode: ends with the tokens generated so far', () => {
    const script = {
      requests: [
        { atMs: 0, promptTokens: 500, outputTokens: 1_000, cancelAtMs: 3_000 },
        { atMs: 0, promptTokens: 500, outputTokens: 400 },
      ],
    };
    const [jump, step] = both(script);
    for (const { d, rep } of [jump!, step!]) {
      expect(d.states[0]).toEqual([S.waiting, S.prefill, S.decode, S.timedOut]);
      expect(d.endMs[0]).toBe(3_000);
      expect(d.outputDone[0]).toBeGreaterThan(50);
      expect(d.outputDone[0]).toBeLessThan(1_000);
      expect(d.outcome[1]).toBe(OUTCOME.finished);
      expect(rep.pool.referencedCount).toBe(0);
    }
    expect(jump!.d.outputDone).toEqual(step!.d.outputDone);
    expect(Math.abs(jump!.d.endMs[1]! - step!.d.endMs[1]!)).toBeLessThan(1e-6);
  });

  it('while preempted: leaves the waiting queue', () => {
    const small = withEngine(cal, { kvPoolTokens: 640, blockSize: 16 });
    const script = {
      requests: [
        { atMs: 0, session: 1, promptTokens: 200, outputTokens: 300 },
        { atMs: 0, session: 2, promptTokens: 200, outputTokens: 300 },
      ],
    };
    // Find when request 1 is preempted, then cancel it just after.
    const probe = both(script, {}, small)[1]!;
    expect(probe.d.states[1]).toContain(S.preempted);
    const firstEnd = probe.d.endMs[0]!;
    const cancelled = {
      requests: [script.requests[0]!, { ...script.requests[1]!, cancelAtMs: firstEnd - 1 }],
    };
    for (const { d, rep } of both(cancelled, {}, small)) {
      const st = d.states[1]!;
      expect(st[st.length - 1]).toBe(S.timedOut);
      expect(st[st.length - 2]).toBe(S.preempted);
      expect(d.outcome[0]).toBe(OUTCOME.finished);
      expect(rep.pool.referencedCount).toBe(0);
    }
  });

  it('after the request ended: ignored', () => {
    const script = {
      requests: [{ atMs: 0, promptTokens: 100, outputTokens: 3, cancelAtMs: 60_000 }],
    };
    for (const { d } of both(script)) expect(d.outcome[0]).toBe(OUTCOME.finished);
  });
});

describe('crash and rejoin (02 §9)', () => {
  const config = testConfig({ tunable: { systemPromptTokens: 800 } });
  const req = { promptTokens: 1_500, outputTokens: 400, systemPromptTokens: 800 };
  const script: Script = {
    requests: [
      { atMs: 0, session: 1, ...req }, // warm: hits the morning system prompt
      { atMs: 100, session: 2, ...req },
      { atMs: 20_000, session: 3, ...req }, // dispatched while down: connection reset
      { atMs: 40_000, session: 4, ...req }, // after rejoin: empty cache
      { atMs: 41_000, session: 5, ...req, promptTokens: 20_000, outputTokens: 1 },
    ],
    replicaChanges: [
      { atMs: 5_000, replica: 0, state: R.crashed },
      { atMs: 10_000, replica: 0, state: R.down },
      { atMs: 15_000, replica: 0, state: R.loadingWeights },
      { atMs: 25_000, replica: 0, state: R.initializingEngine },
      { atMs: 30_000, replica: 0, state: R.ready },
    ],
  };

  it('fails everything held, refuses dispatches until Ready, then rejoins cold', () => {
    const [jump, step] = both(script, { config });
    for (const { d, rep, run } of [jump!, step!]) {
      expect(d.cachedTokens[0]).toBe(800);
      expect(d.outcome.slice(0, 3)).toEqual([OUTCOME.failed, OUTCOME.failed, OUTCOME.failed]);
      expect(d.endMs.slice(0, 3)).toEqual([5_000, 5_000, 20_000]);
      expect(d.states[2]).toEqual([S.failed]);
      expect(d.outputDone[0]).toBeGreaterThan(0);
      // Rejoined with an empty pool: no system-prompt hit, full-prompt TTFT.
      expect(d.outcome[3]).toBe(OUTCOME.finished);
      expect(d.cachedTokens[3]).toBe(0);
      expect(d.firstTokenMs[3]! - 40_000).toBeCloseTo(batch1TtftMs(1_500, 8_192, cal), 6);
      // ...and later requests hit what it computed.
      expect(d.cachedTokens[4]).toBe(800);
      expect(rep.pool.referencedCount).toBe(0);
      expect(Array.from(run.state.shared.requests.live).includes(1)).toBe(false);
    }
    expect(jump!.d.outputDone).toEqual(step!.d.outputDone);
    const m = [jump!, step!].map((x) => x.run.state.shared.meters.replica);
    expect(m[0]!.busyMs[0]).toBeCloseTo(m[1]!.busyMs[0]!, 6);
    expect(m[0]!.decodeTokens[0]).toBeCloseTo(m[1]!.decodeTokens[0]!, 6);
  });
});

describe('requests that could never run fail at dispatch', () => {
  it('prompt + output beyond the pool or maxModelLen', () => {
    const small = withEngine(cal, { kvPoolTokens: 1_024, blockSize: 16 });
    const script = {
      requests: [
        { atMs: 0, promptTokens: 1_000, outputTokens: 30 }, // 1,029 KV tokens > 1,024
        { atMs: 0, promptTokens: 1_000, outputTokens: 25 }, // 1,024: fits exactly
      ],
    };
    for (const { d } of both(script, {}, small)) {
      expect(d.outcome).toEqual([OUTCOME.failed, OUTCOME.finished]);
      expect(d.states[0]).toEqual([S.failed]);
    }
    const long = { requests: [{ atMs: 0, promptTokens: 131_000, outputTokens: 100 }] };
    for (const { d } of both(long)) expect(d.outcome[0]).toBe(OUTCOME.failed);
  });
});
