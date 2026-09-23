// The oracle on its own, against hand-checkable cases: E3's batch-1 reference times, chunking,
// preemption with recompute, prefix hits across turns, timeouts, crashes, same-instant arrivals,
// and the router's KV signal. The engine is not involved.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../calibration.ts';
import { batch1TpotMs, batch1TtftMs } from '../cost/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import { testConfig, withEngine, type ConfigOverrides } from '../replica/harness.ts';
import { runOracle } from './sim.ts';
import type { OracleInput, OracleReplicaChange, OracleRequestSpec } from './types.ts';

const cal = parseCalibration(raw);
const CHUNK = cal.engine.maxNumBatchedTokens;
const S = REQUEST_STATE;

function relClose(actual: number, expected: number, tol = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

function req(
  atMs: number,
  promptTokens: number,
  outputTokens: number,
  extra: Partial<OracleRequestSpec> = {},
) {
  return { atMs, session: 0, turn: 1, promptTokens, outputTokens, systemPromptTokens: 0, ...extra };
}

function run(
  requests: OracleRequestSpec[],
  options: {
    config?: ConfigOverrides;
    engine?: Partial<typeof cal.engine>;
    changes?: OracleReplicaChange[];
  } = {},
) {
  const input: OracleInput = {
    seed: 1,
    cal: withEngine(cal, options.engine ?? {}),
    config: testConfig(options.config),
    day: 0,
    requests,
    replicaChanges: options.changes ?? [],
  };
  const out = runOracle(input, { trace: true });
  const r = out.requests;
  const states = (i: number) => r.transitions[i]!.filter((_, k) => k % 2 === 1);
  return { ...out, r, states };
}

/** Batch-1 end time: TTFT, then one decode step per further token at growing context. */
function batch1EndMs(prompt: number, output: number, cached = 0): number {
  let ms = batch1TtftMs(prompt, CHUNK, cal, cached);
  for (let g = 1; g < output; g++) ms += batch1TpotMs(prompt + g, cal);
  return ms;
}

describe('the oracle alone', () => {
  it('batch-1 times equal E3 reference helpers, chunked prefill included', () => {
    for (const [prompt, output] of [
      [1_000, 20],
      [20_000, 5],
      [16, 1],
    ] as const) {
      const { r, steps, states } = run([req(1_000, prompt, output)]);
      relClose(r.firstTokenMs[0]! - 1_000, batch1TtftMs(prompt, CHUNK, cal));
      relClose(r.endMs[0]! - 1_000, batch1EndMs(prompt, output));
      expect(r.outcome[0]).toBe(OUTCOME.finished);
      expect(r.outputDone[0]).toBe(output);
      // Chunks of max_num_batched_tokens; the first token comes with the last one.
      const chunks = steps.filter((s) => s.chunks.length > 0).map((s) => s.chunks);
      expect(chunks.length).toBe(Math.ceil(prompt / CHUNK));
      expect(chunks.at(-1)![1]! + chunks.at(-1)![2]!).toBe(prompt);
      expect(states(0)).toEqual(
        output > 1
          ? [S.waiting, S.prefill, S.decode, S.finished]
          : [S.waiting, S.prefill, S.finished],
      );
    }
  });

  it('same-instant arrivals share the first step; decodes go before prefill chunks', () => {
    const { steps } = run([req(0, 300, 10, { session: 1 }), req(0, 200, 10, { session: 2 })], {
      config: { engineOverrides: { maxNumBatchedTokens: 400 } },
    });
    expect(steps[0]!.chunks).toEqual([0, 0, 300, 1, 0, 100]);
    // Step 2: request 0 decodes (it sampled its first token); request 1 finishes its prefill.
    expect(steps[1]!.decodeSeqs).toBe(1);
    expect(steps[1]!.chunks).toEqual([1, 100, 100]);
    // Step 3: both decode.
    expect(steps[2]!.decodeSeqs).toBe(2);
    expect(steps[2]!.chunks).toEqual([]);
  });

  it('preempts the most recently admitted request, which recomputes prompt + output so far', () => {
    // 64 blocks of 16. Two requests of 25 prompt blocks each grow until the pool is full.
    const { r, states, steps } = run(
      [req(0, 400, 400, { session: 1 }), req(1, 400, 400, { session: 2 })],
      { engine: { kvPoolTokens: 1_024 } },
    );
    expect(r.preemptions).toEqual([0, 1]);
    expect(states(1)).toEqual([
      S.waiting,
      S.prefill,
      S.decode,
      S.preempted,
      S.prefill,
      S.decode,
      S.finished,
    ]);
    expect(r.outputDone).toEqual([400, 400]);
    // Resumed prefill covers prompt and output so far, part of it from the prefix cache.
    const resumed = steps.filter((s) => s.chunks[0] === 1 && s.atMs > r.firstTokenMs[1]!);
    const total = resumed.at(-1)!.chunks[1]! + resumed.at(-1)!.chunks[2]!;
    expect(total).toBeGreaterThan(400);
    expect(steps.find((s) => s.preempted)).toBeDefined();
  });

  it('turn 2 hits turn 1 prompt and output blocks; the hit count is cachedTokens', () => {
    const { r } = run([
      req(0, 100, 50, { session: 7 }),
      req(10, 180, 5, { session: 7, turn: 2, after: 0 }),
    ]);
    // Turn 1 leaves KV for 149 tokens: 9 full blocks.
    expect(r.cachedTokens).toEqual([0, 144]);
    relClose(r.firstTokenMs[1]! - r.arriveMs[1]!, batch1TtftMs(180, CHUNK, cal, 144));
  });

  it('a timeout while waiting ends the request with nothing generated', () => {
    const { r, states } = run(
      [req(0, 1_000, 200, { session: 1 }), req(10, 1_000, 5, { session: 2, timeoutMs: 500 })],
      { config: { engineOverrides: { maxNumSeqs: 1 } } },
    );
    expect(r.outcome).toEqual([OUTCOME.finished, OUTCOME.timedOut]);
    expect(states(1)).toEqual([S.waiting, S.timedOut]);
    expect(r.endMs[1]).toBe(510);
    expect(r.outputDone[1]).toBe(0);
  });

  it('a crash fails what the replica holds; it rejoins with an empty cache', () => {
    const R = REPLICA_STATE;
    const { r, pools } = run(
      [
        req(0, 500, 2_000, { session: 3 }),
        req(0, 100, 10, { session: 4 }),
        req(20_000, 520, 5, { session: 3, turn: 2 }),
      ],
      {
        changes: [
          { atMs: 5_000, replica: 0, state: R.crashed },
          { atMs: 5_500, replica: 0, state: R.down },
          { atMs: 10_000, replica: 0, state: R.ready },
        ],
      },
    );
    expect(r.outcome).toEqual([OUTCOME.failed, OUTCOME.finished, OUTCOME.finished]);
    expect(r.endMs[0]).toBe(5_000);
    expect(r.outputDone[0]).toBeGreaterThan(10);
    expect(r.cachedTokens[2]).toBe(0);
    expect(pools[0]!.evictions).toBe(0);
  });

  it('kvUtilization sends a request to the replica with less KV in use', () => {
    const { r } = run([req(0, 4_000, 500, { session: 1 }), req(1_000, 100, 5, { session: 2 })], {
      config: { replicas: 2, tunable: { routingPolicy: 'kvUtilization', signalRefreshMs: 0 } },
    });
    expect(r.replica[1]).toBe(1 - r.replica[0]!);
  });
});
