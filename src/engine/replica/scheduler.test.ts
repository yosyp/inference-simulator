// Scheduling rules (02 §7 rules 1-5) and batch-1 timing against E3's reference helpers.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.provisional.json';
import { parseCalibration } from '../calibration.ts';
import { batch1TpotMs, batch1TtftMs } from '../cost/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import { runScript, testConfig, withEngine, type HarnessOptions, type Script } from './harness.ts';
import type { StepInfo } from './steps.ts';

const cal = parseCalibration(raw);
const CHUNK = cal.engine.maxNumBatchedTokens;
const S = REQUEST_STATE;

function relClose(actual: number, expected: number, tol = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

/** Runs the day with invariants after every event, in both jumping modes; returns both. */
function both(script: Script, options: HarnessOptions = {}, calibration = cal) {
  return [true, false].map((eventJumping) => {
    const steps: StepInfo[] = [];
    const h = runScript(calibration, script, {
      ...options,
      eventJumping,
      onStep: (s) => steps.push(s),
      runner: { assertEveryEvent: true },
    });
    h.run.advance(h.run.dayEndMs);
    h.run.assertInvariants();
    return { ...h, d: h.driver(), steps };
  });
}

/** Batch-1 end time: TTFT, then one decode step per further token at growing context. */
function batch1EndMs(prompt: number, output: number, cached = 0): number {
  let ms = batch1TtftMs(prompt, CHUNK, cal, cached);
  for (let g = 1; g < output; g++) ms += batch1TpotMs(prompt + g, cal);
  return ms;
}

describe('batch-1 timing matches E3 reference helpers', () => {
  const cases = [
    { prompt: 1_000, output: 20 },
    { prompt: 20_000, output: 5 }, // three chunks
    { prompt: 16, output: 1 }, // finishes at its first token
  ];
  for (const { prompt, output } of cases) {
    it(`prompt ${prompt}, output ${output}`, () => {
      const at = 1_000;
      for (const { d } of both({
        requests: [{ atMs: at, promptTokens: prompt, outputTokens: output }],
      })) {
        expect(d.outcome[0]).toBe(OUTCOME.finished);
        relClose(d.firstTokenMs[0]! - at, batch1TtftMs(prompt, CHUNK, cal));
        relClose(d.endMs[0]! - at, batch1EndMs(prompt, output));
        expect(d.outputDone[0]).toBe(output);
        expect(d.cachedTokens[0]).toBe(0);
        expect(d.preemptions[0]).toBe(0);
      }
    });
  }

  it('the morning cache holds the system prompt; hits skip its prefill', () => {
    const script = {
      requests: [{ atMs: 0, promptTokens: 1_000, outputTokens: 10, systemPromptTokens: 800 }],
    };
    const config = testConfig({ tunable: { systemPromptTokens: 800 } });
    for (const { d, run } of both(script, { config })) {
      expect(d.cachedTokens[0]).toBe(800);
      relClose(d.firstTokenMs[0]!, batch1TtftMs(1_000, CHUNK, cal, 800));
      relClose(d.endMs[0]!, batch1EndMs(1_000, 10, 800));
      const m = run.state.shared.meters.replica;
      expect(m.prefixQueryTokens[0]).toBe(1_000);
      expect(m.prefixHitTokens[0]).toBe(800);
      expect(m.prefillTokens[0]).toBeCloseTo(200, 6);
      expect(m.decodeTokens[0]).toBeCloseTo(9, 6);
    }
  });

  it('a first token exactly at the client deadline counts (K8: engine before client)', () => {
    const ttft = batch1TtftMs(1_000, CHUNK, cal);
    const script = {
      requests: [{ atMs: 0, promptTokens: 1_000, outputTokens: 5, timeoutMs: ttft }],
    };
    for (const { d } of both(script)) {
      expect(d.firstTokenMs[0]).toBe(ttft);
      expect(d.outcome[0]).toBe(OUTCOME.finished);
    }
    const late = {
      requests: [{ atMs: 0, promptTokens: 1_000, outputTokens: 5, timeoutMs: ttft * 0.999 }],
    };
    for (const { d } of both(late)) expect(d.outcome[0]).toBe(OUTCOME.timedOut);
  });
});

describe('request overhead and cached-token cost (X4a)', () => {
  const xcal = {
    ...cal,
    costModel: {
      ...cal.costModel,
      decodePerSeqMs: 0.097,
      cachedTokenMs: 0.0059,
      requestOverheadMs: 18.8,
    },
  };
  const config = testConfig({ tunable: { systemPromptTokens: 800 } });

  it('batch-1 TTFT is the overhead plus the steps; the admitting step pays for its hits', () => {
    const script = {
      requests: [{ atMs: 100, promptTokens: 1_000, outputTokens: 10, systemPromptTokens: 800 }],
    };
    for (const { d, steps } of both(script, { config }, xcal)) {
      expect(d.cachedTokens[0]).toBe(800);
      expect(steps[0]!.atMs).toBeCloseTo(100 + 18.8, 9);
      relClose(d.firstTokenMs[0]! - 100, batch1TtftMs(1_000, CHUNK, xcal, 800));
      let end = batch1TtftMs(1_000, CHUNK, xcal, 800);
      for (let g = 1; g < 10; g++) end += batch1TpotMs(1_000 + g, xcal);
      relClose(d.endMs[0]! - 100, end);
      expect(d.states[0]).toEqual([S.waiting, S.prefill, S.decode, S.finished]);
    }
  });

  it('a request cancelled or failed during its overhead never runs', () => {
    const script = {
      requests: [
        { atMs: 0, promptTokens: 500, outputTokens: 5, cancelAtMs: 10 },
        { atMs: 50, promptTokens: 500, outputTokens: 5 },
      ],
      replicaChanges: [{ atMs: 60, replica: 0, state: REPLICA_STATE.crashed }],
    };
    for (const { d, steps } of both(script, {}, xcal)) {
      expect(d.outcome[0]).toBe(OUTCOME.timedOut);
      expect(d.outcome[1]).toBe(OUTCOME.failed);
      expect(steps).toHaveLength(0);
    }
  });
});

describe('step composition (rule 2)', () => {
  it('same-instant arrivals share the first step; decodes go before prefill chunks', () => {
    const script = {
      requests: [
        { atMs: 0, promptTokens: 6_000, outputTokens: 50 },
        { atMs: 0, promptTokens: 6_000, outputTokens: 50 },
      ],
    };
    for (const { steps, d } of both(script)) {
      const [a, b] = [0, 1].map((i) => d.states[i]);
      expect(a).toEqual([S.waiting, S.prefill, S.decode, S.finished]);
      expect(b).toEqual([S.waiting, S.prefill, S.decode, S.finished]);
      // Step 0: A's whole prompt, then B's first chunk fills the budget.
      expect(steps[0]!.decodeSeqs).toBe(0);
      expect(steps[0]!.chunks.filter((_, i) => i % 3 !== 0)).toEqual([0, 6_000, 0, CHUNK - 6_000]);
      // Step 1: A decodes first, then B's remaining chunk.
      expect(steps[1]!.decodeSeqs).toBe(1);
      expect(steps[1]!.decodeContextTokens).toBe(6_001);
      expect(steps[1]!.chunks.filter((_, i) => i % 3 !== 0)).toEqual([
        CHUNK - 6_000,
        12_000 - CHUNK,
      ]);
      expect(d.firstTokenMs[0]).toBeLessThan(d.firstTokenMs[1]!);
    }
  });

  it('never exceeds max_num_batched_tokens or max_num_seqs', () => {
    const requests = Array.from({ length: 12 }, (_, i) => ({
      atMs: i * 37,
      promptTokens: 100 + ((i * 397) % 900),
      outputTokens: 20 + ((i * 131) % 80),
    }));
    const config = testConfig({ engineOverrides: { maxNumSeqs: 3, maxNumBatchedTokens: 256 } });
    for (const { steps, d } of both({ requests }, { config })) {
      for (const s of steps) {
        let tokens = s.decodeSeqs;
        for (let i = 2; i < s.chunks.length; i += 3) tokens += s.chunks[i]!;
        expect(tokens).toBeLessThanOrEqual(256);
        expect(s.decodeSeqs + s.chunks.length / 3).toBeLessThanOrEqual(3);
      }
      expect(d.outcome.every((o) => o === OUTCOME.finished)).toBe(true);
    }
  });

  it('max_num_seqs holds a request back until a running one finishes', () => {
    const config = testConfig({ engineOverrides: { maxNumSeqs: 1 } });
    const script = {
      requests: [
        { atMs: 0, promptTokens: 500, outputTokens: 30 },
        { atMs: 1, promptTokens: 500, outputTokens: 30 },
      ],
    };
    for (const { d } of both(script, { config })) {
      expect(d.firstTokenMs[1]).toBeGreaterThan(d.endMs[0]!);
      relClose(d.endMs[0]!, batch1EndMs(500, 30));
    }
  });
});

describe('admission (rule 1)', () => {
  // 64 blocks of 16 tokens; chunks of 256 tokens.
  const small = withEngine(cal, { kvPoolTokens: 1_024, blockSize: 16 });
  const config = testConfig({ engineOverrides: { maxNumBatchedTokens: 256 } });

  it('waits until the whole uncached prompt fits, then allocates chunk by chunk', () => {
    const script = {
      requests: [
        { atMs: 0, session: 1, promptTokens: 512, outputTokens: 100 }, // 32 blocks, grows to 38
        { atMs: 50, session: 2, promptTokens: 600, outputTokens: 5 }, // needs 38; first chunk 16
        { atMs: 60, session: 3, promptTokens: 16, outputTokens: 2 }, // fits, but FIFO blocks it
      ],
    };
    for (const { d, steps } of both(script, { config }, small)) {
      expect(d.firstTokenMs[1]).toBeGreaterThan(d.endMs[0]!);
      expect(d.preemptions).toEqual([0, 0, 0]);
      // B's first step allocates only its first chunk (slots are 0, 1, 2 in dispatch order).
      const chunksOf = (slot: number) =>
        steps.flatMap((s, i) =>
          s.chunks.flatMap((c, j) =>
            j % 3 === 0 && c === slot ? [[i, s.chunks[j + 1]!, s.chunks[j + 2]!]] : [],
          ),
        );
      expect(chunksOf(1)).toEqual([
        [expect.any(Number), 0, 256],
        [expect.any(Number), 256, 256],
        [expect.any(Number), 512, 88],
      ]);
      // C fits the whole time but queues behind B (head-of-line): it shares B's last chunk step.
      expect(chunksOf(2)).toHaveLength(1);
      expect(chunksOf(2)[0]![0]).toBe(chunksOf(1)[2]![0]);
      expect(d.firstTokenMs[2]).toBe(d.firstTokenMs[1]);
    }
  });
});

describe('block growth and preemption (rules 3-5)', () => {
  // 40 blocks. Two 200-token prompts growing to 499 tokens each need 64 blocks: one is preempted.
  const small = withEngine(cal, { kvPoolTokens: 640, blockSize: 16 });
  const script = {
    requests: [
      { atMs: 0, session: 1, promptTokens: 200, outputTokens: 300 },
      { atMs: 0, session: 2, promptTokens: 200, outputTokens: 300 },
    ],
  };

  it('preempts the most recently admitted request, which recomputes with prefix hits', () => {
    for (const { d, run, steps } of both(script, {}, small)) {
      expect(d.outcome).toEqual([OUTCOME.finished, OUTCOME.finished]);
      expect(d.preemptions[0]).toBe(0);
      expect(d.preemptions[1]).toBeGreaterThanOrEqual(1);
      expect(d.states[1]).toContain(S.preempted);
      expect(d.outputDone).toEqual([300, 300]);
      // A runs alone after the preemption, so it finishes at its batch-1 pace from then on.
      expect(d.endMs[0]).toBeLessThan(d.endMs[1]!);
      const m = run.state.shared.meters.replica;
      expect(m.preemptions[0]).toBe(d.preemptions[1]);
      expect(m.recomputedPrefillTokens[0]).toBeGreaterThan(0);
      // B's resume looked up prompt + output so far and hit its own registered blocks.
      expect(m.prefixQueryTokens[0]).toBeGreaterThan(400);
      expect(m.prefixHitTokens[0]).toBeGreaterThan(0);
      expect(steps.some((s) => s.preempted)).toBe(true);
      expect(run.state.replica.replicas[0]!.pool.referencedCount).toBe(0);
    }
  });

  it('cachedTokens is set by the admission that produced the first token', () => {
    for (const { d } of both(script, {}, small)) expect(d.cachedTokens).toEqual([0, 0]);
  });
});

describe('prefix cache across turns (rule 5)', () => {
  it('turn 2 hits turn 1 prompt and output blocks', () => {
    const script = {
      requests: [
        { atMs: 0, session: 7, turn: 1, promptTokens: 1_000, outputTokens: 100 },
        { atMs: 1_000, after: 0, session: 7, turn: 2, promptTokens: 1_150, outputTokens: 10 },
      ],
    };
    for (const { d, run } of both(script)) {
      // Turn 1 left KV for 1,099 tokens: 68 full blocks.
      expect(d.cachedTokens[1]).toBe(1_088);
      relClose(d.firstTokenMs[1]! - d.dispatchMs[1]!, batch1TtftMs(1_150, CHUNK, cal, 1_088));
      const m = run.state.shared.meters.replica;
      expect(m.returningQueryTokens[0]).toBe(1_150);
      expect(m.returningHitTokens[0]).toBe(1_088);
    }
  });

  it('goes cold when another session evicts the history', () => {
    const small = withEngine(cal, { kvPoolTokens: 2_048, blockSize: 16 }); // 128 blocks
    const script = {
      requests: [
        { atMs: 0, session: 7, turn: 1, promptTokens: 1_000, outputTokens: 100 },
        { atMs: 20_000, session: 8, promptTokens: 2_030, outputTokens: 2 },
        { atMs: 40_000, after: 0, session: 7, turn: 2, promptTokens: 1_150, outputTokens: 10 },
      ],
    };
    for (const { d, run } of both(script, {}, small)) {
      expect(d.cachedTokens[2]).toBeLessThan(100);
      expect(run.state.shared.meters.replica.evictedBlocks[0]).toBeGreaterThanOrEqual(60);
    }
  });
});
