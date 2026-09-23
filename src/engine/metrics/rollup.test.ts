import { describe, expect, it } from 'vitest';
import { OUTCOME } from '../results.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, rollupDeliveryMs } from '../time.ts';
import { DAY, END, START, join, metricsRunner, testInput } from './fixtures/harness.ts';
import { scriptStub, servedRequest, type Action } from './fixtures/script-stub.ts';
import { synthStub } from './fixtures/synth-stub.ts';
import { dayRollup } from './index.ts';

const H = HOUR_MS;
const SHIFT_MS = 12 * H; // 07:00–19:00 in testConfig

function rollupOf(actions: Action[], shift?: { startMs: number; endMs: number }) {
  const run = metricsRunner([scriptStub(actions)]).createDayRun(
    testInput({ replicas: 2, detail: 'all', shift }),
  );
  run.advance(END);
  return dayRollup(run.state);
}

describe('rollup', () => {
  it('counts served requests, mean E2E, and busy time over the shift', () => {
    const rows = rollupOf([
      ...servedRequest({ key: 0, at: 9 * H, replica: 0, ttftMs: 200, e2eMs: 1_000, outputDone: 9 }),
      ...servedRequest({
        key: 1,
        at: 10 * H,
        replica: 0,
        ttftMs: 300,
        e2eMs: 3_000,
        outputDone: 9,
      }),
      // Served after the shift: still served that day.
      ...servedRequest({
        key: 2,
        at: 21 * H,
        replica: 0,
        ttftMs: 300,
        e2eMs: 5_000,
        outputDone: 9,
      }),
      // Failed and timed-out requests are not served.
      { at: 11 * H, do: 'arrive', key: 3 },
      { at: 11 * H + 1, do: 'dispatch', key: 3, replica: 1 },
      { at: 11 * H + 2, do: 'end', key: 3, outcome: OUTCOME.failed },
      { at: 8 * H, do: 'counter', replica: 0, counter: 'busyMs', add: 3_600_000 },
      { at: 6 * H, do: 'counter', replica: 0, counter: 'busyMs', add: 1_000_000 }, // before
      { at: 19 * H - 5_000, do: 'counter', replica: 1, counter: 'busyMs', add: 2_160_000 },
      { at: 19 * H, do: 'counter', replica: 1, counter: 'busyMs', add: 500 }, // after
    ]);
    expect(rows).toEqual([
      {
        day: DAY,
        replica: 0,
        requestsServed: 3,
        meanE2eMs: 3_000,
        meanNvidiaSmiUtil: 3_600_000 / SHIFT_MS,
        deliveredAtMs: rollupDeliveryMs(DAY),
      },
      {
        day: DAY,
        replica: 1,
        requestsServed: 0,
        meanE2eMs: NaN,
        meanNvidiaSmiUtil: 2_160_000 / SHIFT_MS,
        deliveredAtMs: rollupDeliveryMs(DAY),
      },
    ]);
    expect(rows[0]!.deliveredAtMs).toBe((DAY + 1) * DAY_MS + 12 * H);
  });

  it('pro-rates a bucket that straddles a shift edge', () => {
    const shift = { startMs: 7 * H + 5_000, endMs: 19 * H + 5_000 };
    const rows = rollupOf(
      [
        { at: 7 * H + 1_000, do: 'counter', replica: 0, counter: 'busyMs', add: 1_000 },
        { at: 19 * H + 1_000, do: 'counter', replica: 0, counter: 'busyMs', add: 2_000 },
        { at: 12 * H, do: 'counter', replica: 1, counter: 'busyMs', add: 6_000 },
      ],
      shift,
    );
    expect(rows[0]!.meanNvidiaSmiUtil).toBeCloseTo((500 + 1_000) / SHIFT_MS, 15);
    expect(rows[1]!.meanNvidiaSmiUtil).toBeCloseTo(6_000 / SHIFT_MS, 15);
  });

  it('is empty-safe: an idle day reads zero utilization and NaN latency', () => {
    const rows = rollupOf([]);
    expect(rows.map((r) => [r.requestsServed, r.meanE2eMs, r.meanNvidiaSmiUtil])).toEqual([
      [0, NaN, 0],
      [0, NaN, 0],
    ]);
  });

  it('refuses a day that has not run to its end', () => {
    const run = metricsRunner([scriptStub([])]).createDayRun(testInput());
    run.advance(START + 12 * H);
    expect(() => dayRollup(run.state)).toThrow(/not to its end/);
  });

  it('equals a direct computation from the records and scalars', () => {
    const replicas = 3;
    const run = metricsRunner(
      [
        synthStub({
          gapMs: 300,
          fromMs: 6 * H,
          toMs: 20 * H,
          analysts: 50,
          crash: { replica: 1, atMs: 12 * H + 7 * MINUTE_MS },
        }),
      ],
      false,
    ).createDayRun(testInput({ replicas, detail: 'all' }));
    const j = join([run.advance(START + 10 * H), run.advance(END)]);
    const rows = dayRollup(run.state);
    const req = j.requests;
    const S = replicas + 1;
    const shiftFirst = (7 * H) / 10_000;
    const shiftEnd = (19 * H) / 10_000;
    for (let r = 0; r < replicas; r++) {
      let served = 0;
      let e2e = 0;
      for (let k = 0; k < req.id!.length; k++) {
        if (req.replica![k] !== r || req.outcome![k] !== OUTCOME.finished) continue;
        served++;
        e2e += req.endMs![k]! - req.arriveMs![k]!;
      }
      let busy = 0;
      for (let b = shiftFirst; b < shiftEnd; b++) busy += j.scalars.busyMs[b * S + r + 1]!;
      expect(served).toBeGreaterThan(1_000);
      expect(rows[r]!.requestsServed).toBe(served);
      expect(rows[r]!.meanE2eMs).toBeCloseTo(e2e / served, 6);
      // The scalars are Float32; the rollup accumulates in Float64.
      expect(rows[r]!.meanNvidiaSmiUtil / (busy / SHIFT_MS)).toBeCloseTo(1, 5);
      expect(rows[r]!.meanNvidiaSmiUtil).toBeGreaterThan(0);
    }
    // Every finished request was served by exactly one replica.
    const finishedFleet = j.scalars.finished.filter((_, i) => i % S === 0).reduce((a, b) => a + b);
    expect(rows.reduce((n, row) => n + row.requestsServed, 0)).toBe(finishedFleet);
  });
});
