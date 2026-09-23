import { describe, expect, it } from 'vitest';
import { digestState } from '../core/plain.ts';
import { HISTOGRAM_SPECS, binIndex, quantile } from '../histogram.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE, type ScalarMetric } from '../results.ts';
import {
  END,
  START,
  histTotal,
  join,
  metricsRunner,
  scalarAt,
  testInput,
} from './fixtures/harness.ts';
import { scriptStub, servedRequest, type Action } from './fixtures/script-stub.ts';
import { inFlightTransitions } from './index.ts';

const R = 2;
const F = 0;
const R0 = 1;
const R1 = 2;

// Bucket 0 is [0, 10 s), bucket 1 is [10 s, 20 s); one histogram bucket covers both.
// Request keys arrive in key order, so key k gets request id k.
const SCRIPT: Action[] = [
  // 0: served on replica 0. TTFT 300, E2E 2,300, TPOT (3,300 - 1,300) / 10 = 200.
  ...servedRequest({ key: 0, at: 1_000, replica: 0, ttftMs: 300, e2eMs: 2_300, outputDone: 11 }),
  // 1: served on replica 1 for analyst 1. TTFT 500, E2E 5,500, TPOT 5,000 / 20 = 250.
  ...servedRequest({
    key: 1,
    at: 2_000,
    replica: 1,
    ttftMs: 500,
    e2eMs: 5_500,
    outputDone: 21,
    analyst: 1,
  }),
  // 2: a retry, dispatched to replica 1, times out while waiting.
  { at: 3_000, do: 'arrive', key: 2, attempt: 1 },
  { at: 3_001, do: 'dispatch', key: 2, replica: 1 },
  { at: 4_000, do: 'end', key: 2, outcome: OUTCOME.timedOut, announceState: false },
  // 3: rejected by admission control inside its requestArrived notice.
  { at: 4_000, do: 'arrive', key: 3, rejectOnArrival: true },
  // 4: analyst 1, first token on replica 0, then the replica fails it mid-decode.
  { at: 5_000, do: 'arrive', key: 4, analyst: 1 },
  { at: 5_001, do: 'dispatch', key: 4, replica: 0 },
  { at: 5_400, do: 'first', key: 4 },
  { at: 6_000, do: 'end', key: 4, outcome: OUTCOME.failed, outputDone: 5 },
  // 5: times out at the router, never dispatched.
  { at: 8_000, do: 'arrive', key: 5 },
  { at: 9_500, do: 'end', key: 5, outcome: OUTCOME.timedOut },
  // 6: in flight across the boundary; one output token, so no TPOT. TTFT 1,500, E2E 3,000.
  { at: 9_000, do: 'arrive', key: 6 },
  { at: 9_001, do: 'dispatch', key: 6, replica: 0 },
  { at: 10_500, do: 'first', key: 6 },
  { at: 12_000, do: 'end', key: 6, outcome: OUTCOME.finished, outputDone: 1 },
  // Meters.
  { at: 2_000, do: 'counter', replica: 0, counter: 'prefillTokens', add: 100 },
  { at: 7_000, do: 'counter', replica: 1, counter: 'prefillTokens', add: 50 },
  { at: 15_000, do: 'counter', replica: 0, counter: 'prefillTokens', add: 7 },
  { at: 5_000, do: 'counter', replica: 0, counter: 'busyMs', add: 4_000 },
  { at: 5_000, do: 'counter', replica: 1, counter: 'busyMs', add: 1_000 },
  { at: 6_000, do: 'counter', replica: 1, counter: 'evictedBlocks', add: 3 },
  { at: 9_500, do: 'abandon', add: 2 },
  { at: 2_000, do: 'level', replica: 0, level: 'kvUsed', value: 0.4 },
  { at: 7_000, do: 'level', replica: 0, level: 'kvUsed', value: 0.8 },
  { at: 0, do: 'level', replica: 1, level: 'kvUsed', value: 0.2 },
  { at: 5_000, do: 'level', replica: 0, level: 'running', value: 2 },
  { at: 0, do: 'level', replica: 1, level: 'running', value: 1 },
  { at: 5_000, do: 'level', replica: 1, level: 'waiting', value: 3 },
  { at: 6_000, do: 'level', replica: 1, level: 'waiting', value: 0 },
  { at: 5_000, do: 'level', replica: 0, level: 'outstanding', value: 4 },
  // Replica 1 crashes at 12 s (its KV is wiped at 13 s) and is Ready again at 17 s.
  { at: 12_000, do: 'replica', replica: 1, state: REPLICA_STATE.crashed },
  { at: 13_000, do: 'level', replica: 1, level: 'kvUsed', value: 0 },
  { at: 13_000, do: 'replica', replica: 1, state: REPLICA_STATE.down },
  { at: 14_000, do: 'replica', replica: 1, state: REPLICA_STATE.loadingWeights },
  { at: 15_000, do: 'replica', replica: 1, state: REPLICA_STATE.initializingEngine },
  { at: 17_000, do: 'replica', replica: 1, state: REPLICA_STATE.ready },
];

function runScript(
  actions: Action[],
  detail: 'all' | 'tracked' = 'all',
  trackedAnalyst: number | null = null,
) {
  const run = metricsRunner([scriptStub(actions)]).createDayRun(
    testInput({ replicas: R, detail, trackedAnalyst }),
  );
  const chunks = [run.advance(START + 20_000), run.advance(START + 60_000), run.advance(END)];
  run.assertInvariants();
  return { run, chunks, j: join(chunks) };
}

const all = runScript(SCRIPT);
const at = (m: ScalarMetric, bucket: number, series: number) =>
  scalarAt(all.j, m, bucket, series, R);
const triple = (m: ScalarMetric, bucket = 0) => [F, R0, R1].map((s) => at(m, bucket, s));

describe('scalars from topics', () => {
  it('counts dispatches and outcomes per replica where dispatched, and for the fleet', () => {
    expect(triple('dispatched')).toEqual([5, 3, 2]);
    expect(triple('finished')).toEqual([2, 1, 1]);
    expect(triple('timedOut')).toEqual([2, 0, 1]);
    expect(triple('failed')).toEqual([1, 1, 0]);
    expect(triple('rejected')).toEqual([1, 0, 0]);
    expect(triple('finished', 1)).toEqual([1, 1, 0]);
  });

  it('sums TTFT at first token, E2E and TPOT at the end of finished requests', () => {
    expect(triple('ttftSumMs')).toEqual([1_200, 700, 500]);
    expect(triple('ttftCount')).toEqual([3, 2, 1]);
    expect(triple('e2eSumMs')).toEqual([7_800, 2_300, 5_500]);
    expect(triple('e2eCount')).toEqual([2, 1, 1]);
    expect(triple('tpotSumMs')).toEqual([450, 200, 250]);
    expect(triple('tpotCount')).toEqual([2, 1, 1]);
    // Request 6: TTFT in the bucket of its first token, E2E at its end, no TPOT (one token).
    expect(triple('ttftSumMs', 1)).toEqual([1_500, 1_500, 0]);
    expect(triple('e2eSumMs', 1)).toEqual([3_000, 3_000, 0]);
    expect(triple('tpotCount', 1)).toEqual([0, 0, 0]);
  });

  it('counts offered, organic, and retries at arrival, fleet only', () => {
    expect(triple('offered')).toEqual([7, 0, 0]);
    expect(triple('organic')).toEqual([6, 0, 0]);
    expect(triple('retries')).toEqual([1, 0, 0]);
    expect(triple('offered', 1)).toEqual([0, 0, 0]);
  });
});

describe('scalars from meters', () => {
  it('diffs the cumulative counters per bucket and sums them for the fleet', () => {
    expect(triple('prefillTokens')).toEqual([150, 100, 50]);
    expect(triple('prefillTokens', 1)).toEqual([7, 7, 0]);
    expect(triple('busyMs')).toEqual([5_000, 4_000, 1_000]);
    expect(triple('busyMs', 1)).toEqual([0, 0, 0]);
    expect(triple('evictedBlocks')).toEqual([3, 0, 3]);
    expect(triple('abandonedSessions')).toEqual([2, 0, 0]);
    expect(triple('abandonedSessions', 1)).toEqual([0, 0, 0]);
  });

  it('takes time-weighted level means, summed across replicas for the fleet', () => {
    expect(triple('running')).toEqual([2, 1, 1]);
    expect(triple('running', 1)).toEqual([3, 2, 1]);
    expect(triple('waiting').map((v) => Math.fround(v))).toEqual([0.3, 0, 0.3].map(Math.fround));
    expect(triple('outstanding')).toEqual([2, 2, 0]);
  });

  it('takes KV means and maxes; the fleet mean is over Ready replica-time', () => {
    // Replica 0: 0 for 2 s, 0.4 for 5 s, 0.8 for 3 s. Replica 1: 0.2 throughout.
    expect(at('kvUsedFrac', 0, R0)).toBeCloseTo(0.44, 6);
    expect(at('kvUsedFrac', 0, R1)).toBeCloseTo(0.2, 6);
    expect(at('kvUsedFrac', 0, F)).toBeCloseTo(0.32, 6);
    expect(triple('kvUsedFracMax').map((v) => Math.fround(v))).toEqual(
      [0.8, 0.8, 0.2].map(Math.fround),
    );
    // Bucket 1: replica 1 is Ready for [10, 12) s at 0.2 and [17, 20) s at 0; replica 0 at 0.8.
    // Fleet = (0.8 × 10 s + 0.2 × 2 s + 0 × 3 s) / (10 s + 5 s) = 0.56.
    expect(at('kvUsedFrac', 1, R1)).toBeCloseTo(0.06, 6);
    expect(at('kvUsedFrac', 1, F)).toBeCloseTo(0.56, 6);
    expect(at('kvUsedFracMax', 1, F)).toBeCloseTo(0.8, 6);
  });

  it('tracks the Ready count from replicaState, fleet only', () => {
    expect(triple('readyReplicas')).toEqual([2, 0, 0]);
    // 2 for 2 s, 1 for 5 s, 2 for 3 s.
    expect(at('readyReplicas', 1, F)).toBeCloseTo(1.5, 6);
    expect(at('readyReplicas', 2, F)).toBe(2);
  });

  it('covers the whole day with aligned buckets', () => {
    expect(all.j.scalarStartMs).toBe(START);
    expect(all.j.buckets).toBe(8_640);
    expect(all.j.histStartMs).toBe(START);
    expect(all.j.histBuckets).toBe(1_440);
  });
});

describe('histograms', () => {
  it('counts each sample in its bin for the serving replica and the fleet', () => {
    const bins = (m: 'ttft' | 'tpot' | 'e2e', values: number[]) => {
      const out = new Uint32Array(HISTOGRAM_SPECS[m].bins);
      for (const v of values) out[binIndex(HISTOGRAM_SPECS[m], v)]! += 1;
      return out;
    };
    const expectHist = (m: 'ttft' | 'tpot' | 'e2e', series: number, values: number[]) =>
      expect(histTotal(all.j, m, series, R)).toEqual(bins(m, values));
    expectHist('ttft', R0, [300, 400, 1_500]);
    expectHist('ttft', R1, [500]);
    expectHist('ttft', F, [300, 400, 1_500, 500]);
    expectHist('e2e', R0, [2_300, 3_000]);
    expectHist('e2e', R1, [5_500]);
    expectHist('e2e', F, [2_300, 3_000, 5_500]);
    expectHist('tpot', F, [200, 250]);
    expectHist('tpot', R1, [250]);
  });

  it('places samples in the histogram bucket of their time', () => {
    const late = runScript([
      ...servedRequest({
        key: 0,
        at: 59_000,
        replica: 0,
        ttftMs: 700,
        e2eMs: 1_500,
        outputDone: 3,
      }),
      ...servedRequest({ key: 1, at: 60_000, replica: 1, ttftMs: 100, e2eMs: 200, outputDone: 3 }),
    ]);
    const bins = HISTOGRAM_SPECS.ttft.bins;
    const S = R + 1;
    const cell = (m: 'ttft' | 'e2e', bucket: number) =>
      late.j.hists[m]
        .slice((bucket * S + F) * bins, (bucket * S + F + 1) * bins)
        .reduce((a, b) => a + b, 0);
    // Request 0: first token at 59.7 s (bucket 0), end at 60.5 s (bucket 1).
    expect([cell('ttft', 0), cell('ttft', 1)]).toEqual([1, 1]);
    expect([cell('e2e', 0), cell('e2e', 1)]).toEqual([0, 2]);
  });

  it('gives quantiles of known samples within one bin', () => {
    const values = Array.from({ length: 400 }, (_, k) => 80 * Math.pow(50, k / 399));
    const script = values.flatMap((ttft, k) =>
      servedRequest({
        key: k,
        at: 1_000 + k * 20,
        replica: k % R,
        ttftMs: ttft,
        e2eMs: ttft + 50,
        outputDone: 2,
      }),
    );
    const { j } = runScript(script);
    const spec = HISTOGRAM_SPECS.ttft;
    const counts = histTotal(j, 'ttft', F, R);
    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
      const exact = sorted[Math.ceil(q * sorted.length) - 1]!;
      const est = quantile(spec, counts, 0, q);
      const bin = binIndex(spec, exact);
      const ratio = Math.pow(spec.maxMs / spec.minMs, 1 / spec.bins);
      expect(est / exact).toBeGreaterThan(1 / ratio);
      expect(est / exact).toBeLessThan(ratio);
      expect(binIndex(spec, est * (1 - 1e-12))).toBeGreaterThanOrEqual(bin - 1);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(values.length);
  });
});

describe('records and transitions', () => {
  it("records every ended request under detail 'all', by stable id", () => {
    const r = all.j.requests;
    expect([...all.j.scopes]).toEqual(['all']);
    expect([...r.id!].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const k = r.id!.indexOf(0);
    expect(r.replica![k]).toBe(0);
    expect(r.arriveMs![k]).toBe(START + 1_000);
    expect(r.dispatchMs![k]).toBe(START + 1_001);
    expect(r.firstTokenMs![k]).toBe(START + 1_300);
    expect(r.endMs![k]).toBe(START + 3_300);
    expect(r.outputTokens![k]).toBe(11);
    expect(r.outcome![k]).toBe(OUTCOME.finished);
    const rejected = r.id!.indexOf(3);
    expect(r.replica![rejected]).toBe(-1);
    expect(r.dispatchMs![rejected]).toBeNaN();
    expect(r.outcome![rejected]).toBe(OUTCOME.rejected);
    expect(r.attempt![r.id!.indexOf(2)]).toBe(1);
  });

  it("holds only the tracked analyst's requests under detail 'tracked'", () => {
    const tracked = runScript(SCRIPT, 'tracked', 1);
    expect([...tracked.j.scopes]).toEqual(['tracked']);
    expect(tracked.j.requests.id).toEqual([4, 1]); // in end order
    expect(new Set(tracked.j.transitions.request)).toEqual(new Set([1, 4]));
    // Scalars and histograms don't depend on the scope.
    expect(digestState(tracked.j.scalars)).toBe(digestState(all.j.scalars));
    expect(digestState(tracked.j.hists)).toBe(digestState(all.j.hists));
    const none = runScript(SCRIPT, 'tracked', null);
    expect(none.j.requests.id ?? []).toEqual([]);
    expect(none.j.transitions.request ?? []).toEqual([]);
  });

  it('writes entry, middle, and terminal transitions once each, in order', () => {
    const t = all.j.transitions;
    const rows = (id: number) =>
      t.request!.flatMap((req, k) =>
        req === id ? [[t.atMs![k]! - START, t.replica![k]!, t.state![k]!]] : [],
      );
    const S = REQUEST_STATE;
    expect(rows(0)).toEqual([
      [1_000, -1, S.atRouter],
      [1_001, 0, S.waiting],
      [1_002, 0, S.prefill],
      [1_300, 0, S.decode],
      [3_300, 0, S.finished],
    ]);
    // Rejected inside its own arrival notice: the arrival row still comes first.
    expect(rows(3)).toEqual([
      [4_000, -1, S.atRouter],
      [4_000, -1, S.rejected],
    ]);
    expect(rows(2)).toEqual([
      [3_000, -1, S.atRouter],
      [3_001, 1, S.waiting],
      [4_000, 1, S.timedOut],
    ]);
    expect(rows(5)).toEqual([
      [8_000, -1, S.atRouter],
      [9_500, -1, S.timedOut],
    ]);
    for (let k = 1; k < t.atMs!.length; k++)
      expect(t.atMs![k]).toBeGreaterThanOrEqual(t.atMs![k - 1]!);
  });

  it('records replica events from replicaState', () => {
    expect(all.j.replicaEvents.map((e) => [e.atMs - START, e.replica, e.state])).toEqual([
      [12_000, 1, REPLICA_STATE.crashed],
      [13_000, 1, REPLICA_STATE.down],
      [14_000, 1, REPLICA_STATE.loadingWeights],
      [15_000, 1, REPLICA_STATE.initializingEngine],
      [17_000, 1, REPLICA_STATE.ready],
    ]);
  });

  it('places in-flight requests for a detail window', () => {
    const run = metricsRunner([scriptStub(SCRIPT)]).createDayRun(testInput({ replicas: R }));
    run.advance(START + 5_200);
    const rows = inFlightTransitions(run.state, { detail: 'all', trackedAnalyst: null });
    expect(rows.scope).toBe('all');
    expect([...rows.request]).toEqual([1, 4]);
    expect([...rows.state]).toEqual([REQUEST_STATE.decode, REQUEST_STATE.waiting]);
    expect([...rows.replica]).toEqual([1, 0]);
    expect([...rows.atMs]).toEqual([START + 5_200, START + 5_200]);
    const tracked = inFlightTransitions(run.state, { detail: 'tracked', trackedAnalyst: 0 });
    expect(tracked.count).toBe(0);
  });
});

describe('contract checks', () => {
  it('rejects a replica id out of range', () => {
    const run = metricsRunner([
      scriptStub([
        { at: 1_000, do: 'arrive', key: 0 },
        { at: 1_001, do: 'dispatch', key: 0, replica: 5 },
      ]),
    ]).createDayRun(testInput({ replicas: R }));
    expect(() => run.advance(START + 2_000)).toThrow(/replica 5 out of range/);
  });
});
