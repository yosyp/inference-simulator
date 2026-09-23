// The failure module in a day runner: [shared, load stub, router, replica stub, failure, metrics]
// plus a queue probe. Every run checks every module's invariants after every event.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import type { Patch, SimConfig } from '../api.ts';
import { parseCalibration, type Calibration, type ColdStartCondition } from '../calibration.ts';
import { digestState } from '../core/index.ts';
import { join, scalarAt } from '../metrics/fixtures/harness.ts';
import { OUTCOME, REPLICA_STATE } from '../results.ts';
import { HOUR_MS, MINUTE_MS, SECOND_MS, dayStartMs } from '../time.ts';
import {
  DAY,
  END,
  START,
  crashAt,
  failureRunner,
  probeChecks,
  testConfig,
  testInput,
  type LoadPlan,
  type NoticeRow,
} from './fixtures/harness.ts';
import { isLegalTransition, phaseDurationMs, phaseTiming, replicaPhase } from './index.ts';

const CAL = parseCalibration(raw);
const R = REPLICA_STATE;
const D = 10_000; // detectionDelayMs in testConfig
const T = START + 8 * HOUR_MS; // a bucket boundary
const NO_LOAD: LoadPlan = { fromMs: START, gapMs: 1, count: 0, serviceMs: 1 };
const FLEET = 0;

function runDay(
  plan: LoadPlan,
  patches: readonly Patch[] = [],
  cfg: SimConfig = testConfig(),
  steps: readonly number[] = [END],
  calibration: Calibration = CAL,
) {
  const run = failureRunner(plan).createDayRun(testInput(cfg, calibration, patches));
  const chunks = steps.map((t) => run.advance(t));
  run.assertInvariants();
  return { run, chunks, j: join(chunks), load: run.state.e8load };
}

/** The notices one crash at t produces, through Ready. */
function timeline(
  t: number,
  replica: number,
  cold = CAL.coldStartMs.replacementHost,
  d = D,
): NoticeRow[] {
  const load = t + d;
  return [
    { atMs: t, replica, state: R.crashed },
    { atMs: load, replica, state: R.down },
    { atMs: load, replica, state: R.loadingWeights },
    { atMs: load + cold.weightsLoaded, replica, state: R.initializingEngine },
    { atMs: load + cold.engineReady, replica, state: R.ready },
  ];
}

/** Every replica's notices form a legal path from Ready. */
function expectLegal(notices: readonly NoticeRow[], replicas = 4): void {
  const at = new Array<number>(replicas).fill(R.ready);
  for (const n of notices) {
    expect(isLegalTransition(at[n.replica]!, n.state), `${at[n.replica]} → ${n.state}`).toBe(true);
    at[n.replica] = n.state;
  }
}

const READY_AFTER = D + CAL.coldStartMs.replacementHost.engineReady; // 125 s

describe('phase timeline', () => {
  const conditions: ColdStartCondition[] = ['processRestart', 'hostReboot', 'replacementHost'];
  it.each(conditions)('matches the %s calibration exactly', (coldStart) => {
    const cold = CAL.coldStartMs[coldStart];
    const cfg = testConfig({}, { coldStart });
    const run = failureRunner(NO_LOAD).createDayRun(testInput(cfg, CAL, [crashAt(T, 1)]));
    const phaseAt = (t: number) => {
      run.advance(t);
      return replicaPhase(run.state, 1);
    };
    expect(phaseAt(T)).toEqual({ state: R.ready, startMs: START, endMs: Infinity });
    expect(phaseAt(T + 1)).toEqual({ state: R.crashed, startMs: T, endMs: T + D });
    const load = T + D;
    expect(phaseAt(load + 1)).toEqual({
      state: R.loadingWeights,
      startMs: load,
      endMs: load + cold.weightsLoaded,
    });
    expect(phaseAt(load + cold.weightsLoaded + 1)).toEqual({
      state: R.initializingEngine,
      startMs: load + cold.weightsLoaded,
      endMs: load + cold.engineReady,
    });
    expect(phaseAt(END)).toEqual({
      state: R.ready,
      startMs: load + cold.engineReady,
      endMs: Infinity,
    });
    expect(run.state.e8load.notices).toEqual(timeline(T, 1, cold));
    // The other replicas never left Ready.
    for (const r of [0, 2, 3]) expect(replicaPhase(run.state, r).state).toBe(R.ready);
    expect(run.state.failure.stats).toEqual({ crashes: 1, restarts: 0, ignored: 0 });
    expect(probeChecks.count).toBeGreaterThan(0);
  });

  it('phaseDurationMs gives the same phase lengths without a run', () => {
    const timing = phaseTiming(testConfig(), CAL);
    const cold = CAL.coldStartMs.replacementHost;
    expect(phaseDurationMs(timing, R.crashed)).toBe(D);
    expect(phaseDurationMs(timing, R.down)).toBe(0);
    expect(phaseDurationMs(timing, R.loadingWeights)).toBe(cold.weightsLoaded);
    expect(phaseDurationMs(timing, R.initializingEngine)).toBe(
      cold.engineReady - cold.weightsLoaded,
    );
    expect(phaseDurationMs(timing, R.ready)).toBe(Infinity);
  });

  it('counts load phases from load start, so Ready is exactly engineReady later', () => {
    // Fractional calibration values: Ready must not drift by the rounding of two sums.
    const cal = structuredClone(CAL);
    cal.coldStartMs.replacementHost = { weightsLoaded: 24_987.3, engineReady: 114_993.7 };
    const t = T + 0.1;
    const { load } = runDay(
      NO_LOAD,
      [crashAt(t, 0)],
      testConfig({}, { detectionDelayMs: 9_876.5 }),
      [END],
      cal,
    );
    const loadStart = t + 9_876.5;
    expect(load.notices.map((n) => n.atMs)).toEqual([
      t,
      loadStart,
      loadStart,
      loadStart + 24_987.3,
      loadStart + 114_993.7,
    ]);
  });

  it('a zero detection delay marks the replica down at the crash instant', () => {
    const { load } = runDay(NO_LOAD, [crashAt(T, 2)], testConfig({}, { detectionDelayMs: 0 }));
    expect(load.notices).toEqual(timeline(T, 2, CAL.coldStartMs.replacementHost, 0));
  });
});

describe('notices', () => {
  // Round-robin over 4 replicas, one arrival a second, each served for 10 s.
  const plan: LoadPlan = {
    fromMs: T - 60 * SECOND_MS,
    gapMs: SECOND_MS,
    count: 400,
    serviceMs: 10_000,
  };

  it('announces each change once, in order, at its time', () => {
    const { load, run } = runDay(plan, [crashAt(T, 2)]);
    expect(load.notices).toEqual(timeline(T, 2));
    expectLegal(load.notices);
    // The replica stub failed what it held inside the crash notice, at the crash instant.
    const wipe = run.state.e8replica.wipes;
    expect(wipe).toEqual([[T, 2, expect.any(Number)]]);
    const held = wipe[0]![2]!;
    expect(held).toBeGreaterThanOrEqual(2);
    const i = load.log.indexOf(`${T} replica 2 -> ${R.crashed}`);
    expect(i).toBeGreaterThanOrEqual(0);
    const after = load.log.slice(i + 1, i + 1 + held);
    expect(
      after.every((line) => line.startsWith(`${T} ended`) && line.endsWith(` ${OUTCOME.failed}`)),
    ).toBe(true);
  });

  it('puts mark-down and load start before anything else at their instant', () => {
    // An arrival exactly at mark-down is routed without the downed replica.
    const at = { fromMs: T + D, gapMs: SECOND_MS, count: 8, serviceMs: 1_000 };
    const { load } = runDay(at, [crashAt(T, 0)]);
    const first = load.dispatches[0]!;
    expect(first.atMs).toBe(T + D + 2); // router overhead 2 ms
    expect(load.dispatches.map((d) => d.replica)).not.toContain(0);
  });
});

describe('routing around a crash', () => {
  // Four arrivals a second round-robin: each replica gets one a second.
  const plan: LoadPlan = { fromMs: T - 30 * SECOND_MS, gapMs: 250, count: 1_600, serviceMs: 1_000 };
  const { load, run } = runDay(plan, [crashAt(T, 1)]);
  const toOne = load.dispatches.filter((d) => d.replica === 1);
  const readyAt = T + READY_AFTER;

  it('keeps routing to the crashed replica until mark-down, and those requests fail', () => {
    const blind = toOne.filter((d) => d.atMs >= T && d.atMs < T + D);
    expect(blind.length).toBeGreaterThanOrEqual(9);
    const failed = load.ends.filter((e) => e.replica === 1 && e.atMs >= T && e.atMs < T + D);
    expect(failed.length).toBeGreaterThanOrEqual(blind.length);
    expect(failed.every((e) => e.outcome === OUTCOME.failed)).toBe(true);
    // Every blind dispatch failed at once.
    for (const d of blind) {
      expect(
        load.ends.find((e) => e.session === d.session && e.attempt === d.attempt),
      ).toMatchObject({
        atMs: d.atMs,
        outcome: OUTCOME.failed,
      });
    }
    expect(run.state.e8replica.failedAtDispatch[1]).toBe(blind.length);
  });

  it('stops at mark-down and routes again after Ready', () => {
    expect(toOne.filter((d) => d.atMs >= T + D && d.atMs < readyAt)).toEqual([]);
    const back = toOne.filter((d) => d.atMs >= readyAt);
    expect(back.length).toBeGreaterThan(50);
    expect(back[0]!.atMs).toBeLessThan(readyAt + SECOND_MS);
    const served = load.ends.filter((e) => e.replica === 1 && e.dispatchMs >= readyAt);
    expect(served.every((e) => e.outcome === OUTCOME.finished)).toBe(true);
    // The survivors took the whole load in between.
    const between = load.dispatches.filter((d) => d.atMs >= T + D && d.atMs < readyAt);
    expect(between.length).toBeGreaterThan(400);
    expect(new Set(between.map((d) => d.replica))).toEqual(new Set([0, 2, 3]));
  });

  it('keeps the router’s view in step with each phase', () => {
    const cold = CAL.coldStartMs.replacementHost;
    const r = failureRunner(plan).createDayRun(testInput(testConfig(), CAL, [crashAt(T, 1)]));
    const routable: number[] = [];
    for (const t of [T, T + 1, T + D + 1, T + D + cold.weightsLoaded + 1, T + READY_AFTER + 1]) {
      r.advance(t);
      expect([...r.state.router.seenState]).toEqual([...r.state.failure.state]);
      routable.push(r.state.router.routableCount);
    }
    expect(routable).toEqual([4, 4, 3, 3, 4]);
  });
});

describe('client retries', () => {
  it('failed requests reach the client, whose immediate retries land elsewhere', () => {
    const plan: LoadPlan = {
      fromMs: T - 30 * SECOND_MS,
      gapMs: 250,
      count: 400,
      serviceMs: 1_000,
      maxRetries: 3,
    };
    const { load, j } = runDay(plan, [crashAt(T, 1)]);
    const failed = load.ends.filter((e) => e.outcome === OUTCOME.failed);
    expect(failed.length).toBeGreaterThan(9);
    expect(load.retries).toBe(failed.length);
    // Every session finished in the end: round-robin sends the retry to the next replica.
    const finished = new Set(
      load.ends.filter((e) => e.outcome === OUTCOME.finished).map((e) => e.session),
    );
    expect(finished.size).toBe(plan.count);
    // Metrics counts the retries as offered load in the crash buckets.
    const crashBucket = (T - START) / 10_000;
    const retries = scalarAt(j, 'retries', crashBucket, FLEET, 4);
    expect(retries).toBeGreaterThan(0);
    expect(scalarAt(j, 'offered', crashBucket, FLEET, 4)).toBe(
      scalarAt(j, 'organic', crashBucket, FLEET, 4) + retries,
    );
  });
});

describe('metrics', () => {
  const plan: LoadPlan = { fromMs: T - 60 * SECOND_MS, gapMs: 500, count: 800, serviceMs: 3_000 };
  const { j, load, run } = runDay(plan, [crashAt(T, 3)], testConfig(), [
    T - HOUR_MS,
    T + 65_000,
    END,
  ]);
  const bucket = (t: number) => (t - START) / 10_000;
  const ready = (t: number) => scalarAt(j, 'readyReplicas', bucket(t), FLEET, 4);

  it('readyReplicas dips from the crash until Ready', () => {
    expect(ready(T - 10_000)).toBe(4);
    for (let t = T; t < T + 120_000; t += 10_000) expect(ready(t)).toBe(3);
    expect(ready(T + 120_000)).toBe(3.5); // Ready at T + 125 s
    expect(ready(T + 130_000)).toBe(4);
  });

  it('puts the replica events in the chunks, once each, at their times', () => {
    expect(j.replicaEvents).toEqual(timeline(T, 3));
    expect(j.replicaEvents).toEqual(load.notices);
  });

  it('counts the failures on the crashed replica', () => {
    const s = run.state.e8replica;
    let failed = 0;
    for (let b = bucket(T); b < bucket(T + 20_000); b++) failed += scalarAt(j, 'failed', b, 4, 4);
    expect(failed).toBe(s.failedOnCrash[3]! + s.failedAtDispatch[3]!);
    expect(failed).toBeGreaterThan(0);
  });
});

describe('forks', () => {
  const plan: LoadPlan = { fromMs: T - 10 * MINUTE_MS, gapMs: 500, count: 2_000, serviceMs: 4_000 };

  function forkRun(base: readonly Patch[], forked: readonly Patch[], cutMs: number) {
    const baseline = failureRunner(plan).createDayRun(testInput(testConfig(), CAL, base));
    baseline.advance(cutMs);
    const cp = baseline.checkpoint();
    const fork = failureRunner(plan).restoreDayRun(testInput(testConfig(), CAL, forked), cp);
    const chunk = fork.advance(END);
    fork.assertInvariants();
    return { fork, chunk };
  }

  function fresh(patches: readonly Patch[], cutMs: number) {
    const run = failureRunner(plan).createDayRun(testInput(testConfig(), CAL, patches));
    run.advance(cutMs);
    const chunk = run.advance(END);
    return { run, chunk };
  }

  it.each([
    ['five minutes before the crash', T - 5 * MINUTE_MS],
    ['at the playhead, the crash instant', T],
  ])('a crash added at a fork cut %s matches a fresh run', (_name, cutMs) => {
    const patches = [crashAt(T, 2)];
    const a = fresh(patches, cutMs);
    const b = forkRun([], patches, cutMs);
    expect(digestState(b.chunk)).toBe(digestState(a.chunk));
    expect(digestState(b.fork.state)).toBe(digestState(a.run.state));
    expect(b.chunk.replicaEvents).toEqual(timeline(T, 2));
  });

  it('a fork mid-recovery keeps the baseline crash’s pending phases and adds a new crash', () => {
    const t2 = T + 40_000; // replica 0 is loading weights
    const base = [crashAt(T, 0)];
    const both = [crashAt(T, 0), crashAt(t2, 2)];
    const a = fresh(both, T + 30_000);
    const b = forkRun(base, both, T + 30_000);
    expect(digestState(b.chunk)).toBe(digestState(a.chunk));
    expect(digestState(b.fork.state)).toBe(digestState(a.run.state));
    const events = b.chunk.replicaEvents;
    // The cut fell while replica 0 was loading weights: only its later phases are in the chunk.
    expect(events.filter((e) => e.replica === 0)).toEqual(timeline(T, 0).slice(3));
    expect(events.filter((e) => e.replica === 2)).toEqual(timeline(t2, 2));
  });

  it('a baseline crash gives the same run as the same crash as a fork', () => {
    const baseline = runDay(plan, [crashAt(T, 1)], testConfig(), [T, END]);
    const b = forkRun([], [crashAt(T, 1)], T);
    expect(digestState(b.chunk)).toBe(digestState(baseline.chunks[1]));
    expect(b.chunk.replicaEvents).toEqual(timeline(T, 1));
  });
});

describe('a crash during recovery', () => {
  it('restarts recovery from a crash while loading weights', () => {
    const t2 = T + D + 10_000;
    const { load, run } = runDay(NO_LOAD, [crashAt(T, 1), crashAt(t2, 1)]);
    expect(load.notices).toEqual([...timeline(T, 1).slice(0, 3), ...timeline(t2, 1)]);
    expectLegal(load.notices);
    expect(run.state.failure.stats).toEqual({ crashes: 1, restarts: 1, ignored: 0 });
  });

  it('restarts from a crash while initializing, and one at the Ready instant wins over Ready', () => {
    const readyAt = T + READY_AFTER;
    const t2 = readyAt - 1_000;
    const t3 = t2 + READY_AFTER; // exactly when the restarted recovery would be Ready
    const { load, run } = runDay(NO_LOAD, [crashAt(T, 1), crashAt(t2, 1), crashAt(t3, 1)]);
    expect(load.notices).toEqual([
      ...timeline(T, 1).slice(0, 4),
      ...timeline(t2, 1).slice(0, 4),
      ...timeline(t3, 1),
    ]);
    expectLegal(load.notices);
    expect(run.state.failure.stats).toEqual({ crashes: 1, restarts: 2, ignored: 0 });
  });

  it('ignores a crash before mark-down, including one at the mark-down instant', () => {
    const patches = [crashAt(T, 1), crashAt(T + 5_000, 1), crashAt(T + D, 1)];
    const { load, run } = runDay(NO_LOAD, patches);
    expect(load.notices).toEqual(timeline(T, 1));
    expect(run.state.failure.stats).toEqual({ crashes: 1, restarts: 0, ignored: 2 });
  });

  it('a crash just after Ready is a new crash', () => {
    const t2 = T + READY_AFTER + 1;
    const { load, run } = runDay(NO_LOAD, [crashAt(T, 1), crashAt(t2, 1)]);
    expect(load.notices).toEqual([...timeline(T, 1), ...timeline(t2, 1)]);
    expect(run.state.failure.stats).toEqual({ crashes: 2, restarts: 0, ignored: 0 });
  });

  it('keeps the restarted replica out of the routing set', () => {
    const plan: LoadPlan = { fromMs: T, gapMs: 250, count: 2_000, serviceMs: 1_000 };
    const t2 = T + D + 10_000;
    const { load } = runDay(plan, [crashAt(T, 1), crashAt(t2, 1)]);
    const readyAt = t2 + READY_AFTER;
    const toOne = load.dispatches.filter((d) => d.replica === 1);
    expect(toOne.filter((d) => d.atMs >= T + D && d.atMs < readyAt)).toEqual([]);
    expect(toOne.some((d) => d.atMs >= readyAt)).toBe(true);
  });
});

describe('simultaneous crashes', () => {
  it('runs independent timelines, in patch order at the shared instant', () => {
    const plan: LoadPlan = {
      fromMs: T - 30 * SECOND_MS,
      gapMs: 250,
      count: 1_600,
      serviceMs: 1_000,
    };
    const patches = [crashAt(T, 2), crashAt(T, 0), crashAt(T, 2)];
    const { load, j, run } = runDay(plan, patches);
    // Replica 2's patch came first, so at each shared instant its event is queued first. Load
    // start is queued at mark-down, behind the other replica's mark-down.
    const [a, b] = [timeline(T, 2), timeline(T, 0)];
    expect(load.notices).toEqual([a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3], a[4], b[4]]);
    expectLegal(load.notices);
    expect(run.state.failure.stats).toEqual({ crashes: 2, restarts: 0, ignored: 1 });
    const readyAt = T + READY_AFTER;
    const between = load.dispatches.filter((d) => d.atMs >= T + D && d.atMs < readyAt);
    expect(new Set(between.map((d) => d.replica))).toEqual(new Set([1, 3]));
    expect(scalarAt(j, 'readyReplicas', (T - START) / 10_000 + 1, FLEET, 4)).toBe(2);
  });

  it('with every replica down, the router rejects until one is Ready', () => {
    const plan: LoadPlan = {
      fromMs: T - 30 * SECOND_MS,
      gapMs: 250,
      count: 1_600,
      serviceMs: 1_000,
    };
    const patches = [0, 1, 2, 3].map((r) => crashAt(T, r));
    const { load, run } = runDay(plan, patches);
    const readyAt = T + READY_AFTER;
    const during = load.ends.filter((e) => e.atMs >= T && e.atMs < readyAt);
    const blind = during.filter((e) => e.atMs < T + D);
    const dark = during.filter((e) => e.atMs >= T + D);
    expect(blind.length).toBeGreaterThan(30);
    expect(blind.every((e) => e.outcome === OUTCOME.failed)).toBe(true);
    expect(dark.length).toBeGreaterThan(400);
    expect(dark.every((e) => e.outcome === OUTCOME.rejected && e.replica === -1)).toBe(true);
    expect(run.state.router.stats.rejectedNoReplica).toBe(dark.length);
    expect(load.dispatches.some((d) => d.atMs >= readyAt)).toBe(true);
  });
});

describe('the end of the day', () => {
  it('leaves a phase that outlasts the day pending, with no event', () => {
    const t = END - 60_000;
    const { run, load } = runDay(NO_LOAD, [crashAt(t, 1)]);
    expect(run.done).toBe(true);
    const cold = CAL.coldStartMs.replacementHost;
    expect(load.notices).toEqual(timeline(t, 1).slice(0, 4));
    expect(replicaPhase(run.state, 1)).toEqual({
      state: R.initializingEngine,
      startMs: t + D + cold.weightsLoaded,
      endMs: t + D + cold.engineReady,
    });
    expect(run.state.failure.phaseEv[1]).toBe(-1);
  });

  it('a crash too late for detection stays Crashed, and routed to, until the day ends', () => {
    const t = END - 5_000;
    const plan: LoadPlan = { fromMs: END - 20_000, gapMs: 250, count: 80, serviceMs: 1_000 };
    const { run, load } = runDay(plan, [crashAt(t, 0)]);
    expect(load.notices).toEqual(timeline(t, 0).slice(0, 1));
    expect(replicaPhase(run.state, 0)).toEqual({ state: R.crashed, startMs: t, endMs: t + D });
    const late = load.dispatches.filter((d) => d.replica === 0 && d.atMs >= t);
    expect(late.length).toBeGreaterThanOrEqual(4);
    expect(run.state.e8replica.failedAtDispatch[0]).toBe(late.length);
  });

  it('the next day starts with every replica Ready and ignores the earlier crash', () => {
    const patches = [crashAt(END - 60_000, 1)];
    const next = (DAY + 1) as 2;
    const run = failureRunner(NO_LOAD).createDayRun(testInput(testConfig(), CAL, patches, next));
    const start = dayStartMs(next);
    for (let r = 0; r < 4; r++) {
      expect(replicaPhase(run.state, r)).toEqual({
        state: R.ready,
        startMs: start,
        endMs: Infinity,
      });
    }
    run.advance(start + 24 * HOUR_MS);
    expect(run.state.e8load.notices).toEqual([]);
    expect(run.state.failure.stats).toEqual({ crashes: 0, restarts: 0, ignored: 0 });
  });
});

describe('least-outstanding around a crash', () => {
  // 10 arrivals a second, served for 4 s: about 13 outstanding per survivor at steady state.
  const plan: LoadPlan = { fromMs: T - MINUTE_MS, gapMs: 100, count: 4_000, serviceMs: 4_000 };
  const cfg = testConfig({ routingPolicy: 'leastOutstanding', signalRefreshMs: 0 });
  const { load } = runDay(plan, [crashAt(T, 1)], cfg);
  const readyAt = T + READY_AFTER;

  it('the crashed replica is a black hole until mark-down: it fails fast, so it looks idle', () => {
    // Everything goes to it until the survivors drain (about 3.3 s here); then it ties with them
    // at zero and still wins almost every tie, since a survivor's win keeps it busy for 4 s.
    const drain = load.dispatches.filter((d) => d.atMs > T && d.atMs < T + 3_000);
    expect(drain.length).toBe(30);
    expect(drain.every((d) => d.replica === 1)).toBe(true);
    const blind = load.dispatches.filter((d) => d.atMs > T && d.atMs < T + D);
    const toOne = blind.filter((d) => d.replica === 1).length;
    expect(toOne / blind.length).toBeGreaterThan(0.8);
  });

  it('floods the rejoined replica with new traffic', () => {
    const firstSecond = load.dispatches.filter(
      (d) => d.atMs >= readyAt && d.atMs < readyAt + SECOND_MS,
    );
    expect(firstSecond.slice(0, 8).map((d) => d.replica)).toEqual(new Array<number>(8).fill(1));
    const toOne = firstSecond.filter((d) => d.replica === 1).length;
    expect(toOne / firstSecond.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('determinism', () => {
  const plan: LoadPlan = { fromMs: T - 5 * MINUTE_MS, gapMs: 300, count: 1_500, serviceMs: 2_500 };
  const patches = [crashAt(T, 0), crashAt(T + 30_000, 3), crashAt(T + 60_000, 0)];

  it('the same input gives the same run', () => {
    const a = runDay(plan, patches);
    const b = runDay(plan, patches);
    expect(digestState(b.run.state)).toBe(digestState(a.run.state));
    expect(digestState(b.chunks)).toBe(digestState(a.chunks));
  });

  it('splitting the advance changes nothing the modules compute', () => {
    const one = runDay(plan, patches);
    const steps = Array.from({ length: 144 }, (_, i) => START + (i + 1) * 10 * MINUTE_MS);
    const many = runDay(plan, patches, testConfig(), steps);
    for (const slice of ['failure', 'router', 'e8load', 'e8replica', 'shared'] as const) {
      expect(digestState(many.run.state[slice]), slice).toBe(digestState(one.run.state[slice]));
    }
    expect(many.j.replicaEvents).toEqual(one.j.replicaEvents);
    expect(digestState(many.j.scalars)).toBe(digestState(one.j.scalars));
  });
});

describe('errors and invariants', () => {
  it('rejects a crash of a replica outside the fleet', () => {
    const run = failureRunner(NO_LOAD).createDayRun(testInput(testConfig(), CAL, [crashAt(T, 4)]));
    expect(() => run.advance(END)).toThrow(/crash of replica 4/);
  });

  it('rejects a negative detection delay and a calibration without the cold-start condition', () => {
    const runner = failureRunner(NO_LOAD);
    expect(() =>
      runner.createDayRun(testInput(testConfig({}, { detectionDelayMs: -1 }), CAL)),
    ).toThrow(/detectionDelayMs/);
    const cal = { ...CAL, coldStartMs: {} } as Calibration;
    expect(() => runner.createDayRun(testInput(testConfig(), cal))).toThrow(/coldStartMs/);
  });

  it('catches a lost phase event and a wrong phase end', () => {
    const lost = failureRunner(NO_LOAD).createDayRun(testInput(testConfig(), CAL, [crashAt(T, 1)]));
    lost.advance(T + 1);
    lost.assertInvariants();
    lost.state.failure.phaseEv[1] = -1;
    expect(() => lost.assertInvariants()).toThrow(/no pending phase event/);

    const wrong = failureRunner(NO_LOAD).createDayRun(
      testInput(testConfig(), CAL, [crashAt(T, 1)]),
    );
    wrong.advance(T + D + 1);
    wrong.state.failure.phaseEndMs[1]! += 1;
    expect(() => wrong.assertInvariants()).toThrow(/phase ends at/);
  });

  it('allows only the documented transitions', () => {
    const legal = [
      [R.ready, R.crashed],
      [R.crashed, R.down],
      [R.down, R.loadingWeights],
      [R.loadingWeights, R.initializingEngine],
      [R.initializingEngine, R.ready],
      [R.down, R.crashed],
      [R.loadingWeights, R.crashed],
      [R.initializingEngine, R.crashed],
    ].map(([a, b]) => `${a}>${b}`);
    for (let from = 0; from < 5; from++) {
      for (let to = 0; to < 5; to++) {
        expect(isLegalTransition(from, to), `${from} → ${to}`).toBe(
          legal.includes(`${from}>${to}`),
        );
      }
    }
    expect(isLegalTransition(0, 5)).toBe(false);
    expect(isLegalTransition(-1, 1)).toBe(false);
  });
});
