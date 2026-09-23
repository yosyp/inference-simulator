// Event-jumping (02 §5) against one event per step, over seeded random workloads with KV
// exhaustion, chunked prefill, multi-turn prefix reuse, timeouts, cancels, and crashes. Also:
// meters exact at every bucket boundary, and checkpoint/restore mid-span.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../calibration.ts';
import { digestState, takeLevelMean, type DayState, type EngineModule } from '../core/index.ts';
import { OUTCOME } from '../results.ts';
import { REPLICA_COUNTERS } from '../shared/index.ts';
import { runScript, type DriverSlice } from './harness.ts';
import { MODE } from './state.ts';
import { randomWorkload, type Workload } from './workload.ts';

const cal = parseCalibration(raw);
const SEEDS = Number(process.env.E5_SEEDS ?? 100);

/** Stands in for E9: at each bucket end, snapshots the counters and takes the level means. */
function probeModule(): EngineModule {
  return {
    name: 'e5probe',
    init: () => ({ rows: [] as number[][] }),
    onBucketEnd(state: DayState, boundaryMs: number) {
      const m = state.shared.meters.replica;
      const row = [boundaryMs];
      for (let r = 0; r < m.busyMs.length; r++) {
        for (const c of REPLICA_COUNTERS) row.push(m[c][r]!);
        for (const l of [m.kvUsed, m.running, m.waiting])
          row.push(takeLevelMean(l[r]!, boundaryMs));
      }
      (state as unknown as { e5probe: { rows: number[][] } }).e5probe.rows.push(row);
    },
  } as unknown as EngineModule;
}

function rowsOf(state: DayState): number[][] {
  return (state as unknown as { e5probe: { rows: number[][] } }).e5probe.rows;
}

function simulate(w: Workload, eventJumping: boolean, assertEveryEvent: boolean) {
  let events = 0;
  let spans = 0;
  const h = runScript(w.cal, w.script, {
    config: w.config,
    eventJumping,
    after: [probeModule()],
    onStep: (s) => {
      if (s.steps > 1) spans++;
    },
    runner: {
      assertEveryEvent,
      trace: () => {
        events++;
      },
    },
  });
  // Stop once the workload is done: the rest of the day is empty buckets.
  h.run.advance(h.run.state.core.dayStartMs + 3 * 3_600_000);
  h.run.assertInvariants();
  return { d: h.driver(), rows: rowsOf(h.run.state), events, spans };
}

function close(a: number, b: number, rel: number, abs = 1e-6): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

function compareRequests(seed: number, a: DriverSlice, b: DriverSlice): void {
  for (let i = 0; i < a.script.length; i++) {
    const where = `seed ${seed}, request ${i}`;
    expect(a.outcome[i], where).toBe(b.outcome[i]);
    expect(a.preemptions[i], where).toBe(b.preemptions[i]);
    expect(a.cachedTokens[i], where).toBe(b.cachedTokens[i]);
    expect(a.outputDone[i], where).toBe(b.outputDone[i]);
    expect(a.states[i], where).toEqual(b.states[i]);
    const d0 = a.dispatchMs[i]!;
    const d1 = b.dispatchMs[i]!;
    expect(close(d0, d1, 1e-9, 1e-6), `${where} dispatch ${d0} vs ${d1}`).toBe(true);
    const ttft = [a.firstTokenMs[i]! - d0, b.firstTokenMs[i]! - d1];
    const e2e = [a.endMs[i]! - d0, b.endMs[i]! - d1];
    expect(close(ttft[0]!, ttft[1]!, 1e-6), `${where} TTFT ${ttft}`).toBe(true);
    expect(close(e2e[0]!, e2e[1]!, 1e-6), `${where} E2E ${e2e}`).toBe(true);
  }
}

describe('event-jumping equals one event per step', () => {
  const totals = { requests: 0, preempted: 0, cached: 0, timedOut: 0, failed: 0, spans: 0 };
  const events = { jump: 0, step: 0 };
  const BATCH = 25;

  for (let from = 1; from <= SEEDS; from += BATCH) {
    const to = Math.min(SEEDS, from + BATCH - 1);
    it(`agrees on every request, seeds ${from}-${to}`, { timeout: 120_000 }, () => {
      for (let seed = from; seed <= to; seed++) {
        const w = randomWorkload(seed, cal);
        // Invariants after every event on the first batch (slow); at the end on the rest.
        const checkAll = seed <= BATCH;
        const jump = simulate(w, true, checkAll);
        const step = simulate(w, false, checkAll);
        compareRequests(seed, jump.d, step.d);
        events.jump += jump.events;
        events.step += step.events;
        totals.spans += jump.spans;
        const d = jump.d;
        totals.requests += d.script.length;
        totals.preempted += d.preemptions.filter((p) => p > 0).length;
        totals.cached += d.cachedTokens.filter((c) => c > 0).length;
        totals.timedOut += d.outcome.filter((o) => o === OUTCOME.timedOut).length;
        totals.failed += d.outcome.filter((o) => o === OUTCOME.failed).length;
        expect(d.outcome.includes(-1), `seed ${seed}: a request never ended`).toBe(false);
      }
    });
  }

  it('the workloads exercise preemption, prefix hits, timeouts, crashes, and spans', () => {
    console.info('jumping cross-check', { seeds: SEEDS, ...totals, ...events });
    expect(totals.preempted).toBeGreaterThan(SEEDS / 2);
    expect(totals.cached).toBeGreaterThan(SEEDS * 10);
    expect(totals.timedOut).toBeGreaterThan(SEEDS / 10);
    expect(totals.failed).toBeGreaterThan(SEEDS / 10);
    expect(totals.spans).toBeGreaterThan(SEEDS * 20);
    expect(events.jump).toBeLessThan(events.step / 4);
  });

  it('keeps the meters equal at every bucket boundary', { timeout: 60_000 }, () => {
    for (let seed = 1; seed <= 30; seed++) {
      const w = randomWorkload(seed, cal);
      const jump = simulate(w, true, false);
      const step = simulate(w, false, false);
      expect(jump.rows.length).toBe(step.rows.length);
      for (let i = 0; i < jump.rows.length; i++) {
        const [a, b] = [jump.rows[i]!, step.rows[i]!];
        for (let j = 0; j < a.length; j++) {
          expect(
            close(a[j]!, b[j]!, 1e-7, 1e-6),
            `seed ${seed} row ${i} col ${j}: ${a[j]} vs ${b[j]}`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('meters', () => {
  it('busy time is the whole step and never exceeds the bucket', () => {
    const w = randomWorkload(3, cal);
    const { rows } = simulate(w, true, false);
    const perReplica = REPLICA_COUNTERS.length + 3;
    const busyCol = 1 + REPLICA_COUNTERS.indexOf('busyMs');
    let prev = 0;
    for (const row of rows) {
      const busy = row[busyCol]!;
      expect(busy - prev).toBeLessThanOrEqual(w.config.bucketMs + 1e-6);
      expect(busy).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = busy;
    }
    expect(rows[0]!.length).toBe(1 + perReplica * w.config.replicas);
  });
});

describe('checkpoint and restore', () => {
  it('restoring mid-span continues exactly like the uninterrupted run', { timeout: 60_000 }, () => {
    let tested = 0;
    for (let seed = 1; seed <= 40 && tested < 5; seed++) {
      const w = randomWorkload(seed, cal);
      const opts = { config: w.config, runner: { assertEveryEvent: true } };
      const whole = runScript(w.cal, w.script, opts);
      whole.run.advance(whole.run.state.core.dayStartMs + 3_600_000);
      const digest = digestState(whole.run.state);

      const split = runScript(w.cal, w.script, opts);
      let cut = -1;
      for (let t = split.run.nowMs + 97; t < split.run.state.core.dayStartMs + 120_000; t += 97) {
        split.run.advance(t);
        const reps = split.run.state.replica.replicas;
        const inSpan = reps.some((r) => r.mode === MODE.span && r.spanSteps - r.spanDone > 3);
        if (inSpan) {
          cut = t;
          break;
        }
      }
      if (cut < 0) continue;
      tested++;
      const cp = split.run.checkpoint();
      const restored = split.runner.restoreDayRun(split.input, cp);
      restored.advance(whole.run.state.core.dayStartMs + 3_600_000);
      expect(digestState(restored.state), `seed ${seed}`).toBe(digest);
      split.run.advance(whole.run.state.core.dayStartMs + 3_600_000);
      expect(digestState(split.run.state), `seed ${seed}`).toBe(digest);
    }
    expect(tested).toBe(5);
  });
});
