import { describe, expect, it } from 'vitest';
import { advanceInSteps } from '../core/runner.ts';
import { digestState } from '../core/plain.ts';
import { OUTCOME, chunkTransferables, type ResultChunk } from '../results.ts';
import { HOUR_MS, MINUTE_MS } from '../time.ts';
import {
  END,
  START,
  join,
  metricsRunner,
  testInput,
  type HarnessOptions,
  type Joined,
} from './fixtures/harness.ts';
import { scriptStub, servedRequest, type Action } from './fixtures/script-stub.ts';
import { synthStub, type SynthOptions } from './fixtures/synth-stub.ts';

/** Whole-day data is large: compare digests, and diff only on a mismatch. */
function expectSame(a: Joined, b: Joined): void {
  if (digestState(a) !== digestState(b)) expect(a).toEqual(b);
}

const R = 3;
const SYNTH: SynthOptions = {
  gapMs: 250,
  fromMs: 9 * HOUR_MS,
  toMs: 10 * HOUR_MS + 30 * MINUTE_MS,
  analysts: 40,
  crash: { replica: 2, atMs: 9 * HOUR_MS + 40 * MINUTE_MS + 5_000 },
};
const OPTS: HarnessOptions = { replicas: R, detail: 'all' };

function synthRun(opts: HarnessOptions = OPTS, assertEveryEvent = false) {
  return metricsRunner([synthStub(SYNTH)], assertEveryEvent).createDayRun(testInput(opts));
}

/** Advances through the given times (ms after the day's start), then to the day's end. */
function advanceThrough(run: ReturnType<typeof synthRun>, cuts: number[]): ResultChunk[] {
  const chunks = cuts.map((t) => run.advance(START + t));
  chunks.push(run.advance(END));
  return chunks;
}

const whole = (() => {
  const run = synthRun(OPTS, true);
  const chunks = [run.advance(END)];
  run.assertInvariants();
  return { run, chunks, j: join(chunks), digest: digestState(run.state) };
})();

describe('the synthetic day', () => {
  it('exercises every outcome, the crash, and many buckets', () => {
    const outcomes = new Set(whole.j.requests.outcome);
    expect(outcomes).toEqual(
      new Set([OUTCOME.finished, OUTCOME.rejected, OUTCOME.timedOut, OUTCOME.failed]),
    );
    expect(whole.j.requests.id!.length).toBeGreaterThan(15_000);
    expect(new Set(whole.j.requests.id).size).toBe(whole.j.requests.id!.length);
    expect(whole.j.replicaEvents).toHaveLength(5);
    expect(whole.j.buckets).toBe(8_640);
  });
});

describe('chunk splitting', () => {
  it('gives the same data from many small advances as from one', () => {
    for (const step of [10_000, 60_000, 7_777, 5 * MINUTE_MS]) {
      const run = synthRun();
      const chunks = advanceInSteps(run, END, step);
      expectSame(join(chunks), whole.j);
      expect(digestState(run.state)).toBe(whole.digest);
    }
  }, 60_000);

  it('gives the same data when cuts land on boundaries, on events, and a millisecond off', () => {
    const cuts: number[] = [];
    for (let t = 9 * HOUR_MS - 20_000; t < 9 * HOUR_MS + 30 * MINUTE_MS; t += 9_999) {
      cuts.push(t, t + 1, t + 10_000 - (t % 10_000)); // off, off, on a scalar boundary
    }
    const sorted = [...new Set(cuts)].sort((a, b) => a - b);
    const run = synthRun();
    const chunks = advanceThrough(run, sorted);
    expect(chunks.slice(1, -1).every((c) => c.scalars.count <= 2)).toBe(true);
    expectSame(join(chunks), whole.j);
  }, 30_000);

  it('puts an event exactly on a boundary in the new bucket, however the day is cut', () => {
    const script: Action[] = [
      // First token exactly at the 10 s boundary; end exactly at the 60 s histogram boundary.
      ...servedRequest({
        key: 0,
        at: 9_000,
        replica: 1,
        ttftMs: 1_000,
        e2eMs: 51_000,
        outputDone: 5,
      }),
      { at: 20_000, do: 'counter', replica: 0, counter: 'decodeTokens', add: 9 },
    ];
    const runner = metricsRunner([scriptStub(script)]);
    const input = testInput({ replicas: R, detail: 'all' });
    const one = join([runner.createDayRun(input).advance(END)]);
    const cutRun = runner.createDayRun(input);
    const cut = join(
      [10_000, 20_000, 59_999, 60_000, 60_001]
        .map((t) => cutRun.advance(START + t))
        .concat(cutRun.advance(END)),
    );
    expectSame(cut, one);
    const S = R + 1;
    expect(one.scalars.ttftCount[0 * S]).toBe(0);
    expect(one.scalars.ttftCount[1 * S]).toBe(1);
    expect(one.scalars.e2eCount[5 * S]).toBe(0);
    expect(one.scalars.e2eCount[6 * S]).toBe(1);
    expect(one.scalars.decodeTokens[1 * S]).toBe(0);
    expect(one.scalars.decodeTokens[2 * S]).toBe(9);
  });

  it('emits empty blocks for an advance inside one bucket and after the day ends', () => {
    const run = synthRun();
    const c = run.advance(START + 4_000);
    expect([c.scalars.count, c.histograms.count, c.requests.count]).toEqual([0, 0, 0]);
    expect(c.scalars.startMs).toBe(START);
    run.advance(END);
    const after = run.advance(END);
    expect([after.fromMs, after.toMs, after.scalars.count, after.scalars.startMs]).toEqual([
      END,
      END,
      0,
      END,
    ]);
  });
});

describe('checkpoints', () => {
  it('restores mid-bucket and continues exactly as an uninterrupted run', () => {
    const cpAt = 9 * HOUR_MS + 12 * MINUTE_MS + 4_321;
    const a = synthRun();
    const before = a.advance(START + cpAt);
    expect(a.state.metrics.open.some((v) => v !== 0)).toBe(true); // mid-bucket, data pending
    const cp = a.checkpoint();
    const afterA = advanceThrough(a, [cpAt + 60_000]);
    expectSame(join([before, ...afterA]), whole.j);

    const b = metricsRunner([synthStub(SYNTH)], true).restoreDayRun(testInput(OPTS), cp);
    const afterB = advanceInSteps(b, END, 3 * MINUTE_MS);
    b.assertInvariants();
    expectSame(join(afterB), join(afterA));
    expect(digestState(b.state)).toBe(whole.digest);
  }, 30_000);

  it('may change the recorded scope on restore without changing the metrics', () => {
    const cpAt = 9 * HOUR_MS + 30 * MINUTE_MS + 5_555;
    const a = synthRun();
    a.advance(START + cpAt);
    const cp = a.checkpoint();
    const tracked = { replicas: R, detail: 'tracked', trackedAnalyst: 3 } as const;
    const b = metricsRunner([synthStub(SYNTH)]).restoreDayRun(testInput(tracked), cp);
    const jb = join([b.advance(END)]);
    const ja = join([a.advance(END)]);
    expect(digestState(jb.scalars)).toBe(digestState(ja.scalars));
    expect(digestState(jb.hists)).toBe(digestState(ja.hists));
    expect([...jb.scopes]).toEqual(['tracked']);
    expect(jb.requests.id!.length).toBeGreaterThan(0);
    expect(new Set(jb.requests.analyst)).toEqual(new Set([3]));
    const expected = ja.requests.id!.filter((_, k) => ja.requests.analyst![k] === 3);
    expect(jb.requests.id).toEqual(expected);
  });

  it('checkpoints only the open buckets between advances', () => {
    const run = synthRun();
    run.advance(START + 10 * HOUR_MS + 1_234);
    const s = run.state.metrics;
    expect([s.scalars.count, s.hists.count, s.requests.count, s.transitions.count]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(s.replicaEvents).toEqual([]);
    expect(s.requests.id.length).toBe(0);
  });
});

describe('transfer', () => {
  it('gives every array its own buffer, and all of them transfer', () => {
    const run = synthRun();
    const chunk = run.advance(START + 9 * HOUR_MS + 5 * MINUTE_MS);
    const views: ArrayBufferView[] = [
      ...Object.values(chunk.scalars.data),
      ...Object.values(chunk.histograms.data).flatMap((h) => [h.offsets, h.bins, h.counts]),
      ...Object.values(chunk.requests).filter((v) => ArrayBuffer.isView(v)),
      ...Object.values(chunk.transitions).filter((v) => ArrayBuffer.isView(v)),
    ] as ArrayBufferView[];
    for (const v of views) expect(v.byteLength).toBe(v.buffer.byteLength);
    const transfer = chunkTransferables(chunk);
    expect(transfer).toHaveLength(views.length);
    const copy = structuredClone(chunk, { transfer });
    expect(chunk.requests.id.length).toBe(0); // detached
    expect(copy.requests.count).toBeGreaterThan(0);
    expect(copy.requests.id.length).toBe(copy.requests.count);
  });
});
