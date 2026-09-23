// The failure module in the full engine stack, in E11's order: shared, load (E6), router (E7),
// replica (E5), failure, metrics (E9). E5's invariants (block accounting included) cost about 10 ms
// an event, so these runs check every module's invariants after every event only in windows around
// the crash, mark-down, and rejoin, switching runners through checkpoints, and at each window's end.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import type { DayCheckpoint, DayRunInput, Patch, SimConfig } from '../api.ts';
import { parseCalibration } from '../calibration.ts';
import { createDayRunner, digestState, type CoreDayRun } from '../core/index.ts';
import { loadModule } from '../load/index.ts';
import { join, scalarAt } from '../metrics/fixtures/harness.ts';
import { metricsModule } from '../metrics/index.ts';
import { OUTCOME, REPLICA_STATE, replicaSeries, type ResultChunk } from '../results.ts';
import { replicaModule, replicaRunningCount, replicaWaitingCount } from '../replica/index.ts';
import { routerModule } from '../router/index.ts';
import { sharedModule } from '../shared/index.ts';
import { HOUR_MS, MINUTE_MS, dayStartMs, type DayIndex } from '../time.ts';
import { failureModule, replicaPhase } from './index.ts';

const CAL = parseCalibration(raw);
const DAY: DayIndex = 2;
const START = dayStartMs(DAY);
const T = START + 9 * HOUR_MS;
const D = 10_000;
const READY_AT = T + D + CAL.coldStartMs.replacementHost.engineReady;
const CRASHED = 2;
const FLEET = 0;

const modules = [
  sharedModule,
  loadModule,
  routerModule,
  replicaModule,
  failureModule,
  metricsModule,
] as const;
const fast = createDayRunner(modules);
const checked = createDayRunner(modules, { assertEveryEvent: true });

function config(): SimConfig {
  return {
    seed: 23,
    replicas: 4,
    analystsPerReplica: 100,
    shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
    diurnal: {
      knots: [
        [8 * HOUR_MS, 1],
        [10 * HOUR_MS, 1],
      ],
      dayMultipliers: [1, 1, 1, 1, 1],
    },
    sessionsPerAnalystPerDay: 8,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 2048,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 128,
    routerOverheadMs: 2,
    detectionDelayMs: D,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 800,
      turnsPerSessionMean: 4,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 60_000,
      timeoutToFirstTokenMs: 60_000,
      retryPolicy: 'immediate',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 3,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 0,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

function input(patches: readonly Patch[]): DayRunInput {
  return {
    config: config(),
    calibration: CAL,
    day: DAY,
    patches,
    trackedAnalyst: null,
    detail: 'all',
  };
}

const crash: Patch = { kind: 'event', atMs: T, event: { type: 'crash', replica: CRASHED } };

/** A day run advanced in segments, each checked after every event or not. */
function segmented(patches: readonly Patch[]) {
  let cp: DayCheckpoint | null = null;
  const chunks: ResultChunk[] = [];
  const to = (untilMs: number, check: boolean): CoreDayRun => {
    const runner = check ? checked : fast;
    const run =
      cp === null ? runner.createDayRun(input(patches)) : runner.restoreDayRun(input(patches), cp);
    chunks.push(run.advance(untilMs));
    run.assertInvariants();
    cp = run.checkpoint();
    return run;
  };
  return { to, chunks };
}

/** The crashed replica's KV pool and queues. */
function poolOf(run: CoreDayRun) {
  const pool = run.state.replica.replicas[CRASHED]!.pool;
  return {
    referenced: pool.referencedCount,
    evictable: pool.evictableCount,
    free: pool.freeCount,
    running: replicaRunningCount(run.state, CRASHED),
    waiting: replicaWaitingCount(run.state, CRASHED),
  };
}

describe('the full engine around a crash', () => {
  const { to, chunks } = segmented([crash]);
  const before = poolOf(to(T - 2_000, false));
  const atCrash = poolOf(to(T + 1, true));
  to(T + D + 2_000, true);
  to(READY_AT - 1_000, false);
  const atReady = poolOf(to(READY_AT + 1, true)); // before the first dispatch (router overhead)
  to(READY_AT + 5_000, true);
  const run = to(T + 10 * MINUTE_MS, false);
  const total = run.state.replica.replicas[CRASHED]!.pool.totalBlocks;
  const j = join(chunks);
  const bucket = (t: number) => (t - j.scalarStartMs) / 10_000;
  const rec = j.requests;
  const records = rec.id.map((_, k) => ({
    session: rec.session[k]!,
    turn: rec.turn[k]!,
    attempt: rec.attempt[k]!,
    replica: rec.replica[k]!,
    arriveMs: rec.arriveMs[k]!,
    dispatchMs: rec.dispatchMs[k]!,
    endMs: rec.endMs[k]!,
    cachedTokens: rec.cachedTokens[k]!,
    outcome: rec.outcome[k]!,
  }));

  it('announces the phases at the calibrated times', () => {
    const cold = CAL.coldStartMs.replacementHost;
    expect(j.replicaEvents).toEqual([
      { atMs: T, replica: CRASHED, state: REPLICA_STATE.crashed },
      { atMs: T + D, replica: CRASHED, state: REPLICA_STATE.down },
      { atMs: T + D, replica: CRASHED, state: REPLICA_STATE.loadingWeights },
      {
        atMs: T + D + cold.weightsLoaded,
        replica: CRASHED,
        state: REPLICA_STATE.initializingEngine,
      },
      { atMs: READY_AT, replica: CRASHED, state: REPLICA_STATE.ready },
    ]);
    expect(replicaPhase(run.state, CRASHED)).toEqual({
      state: REPLICA_STATE.ready,
      startMs: READY_AT,
      endMs: Infinity,
    });
  });

  it('fails what the replica held and wipes its KV pool, leaking no blocks', () => {
    expect(before.referenced + before.evictable).toBeGreaterThan(0);
    const failedAtCrash = records.filter(
      (r) => r.replica === CRASHED && r.endMs === T && r.outcome === OUTCOME.failed,
    );
    expect(failedAtCrash.length).toBeGreaterThan(0);
    const empty = { referenced: 0, evictable: 0, free: total, running: 0, waiting: 0 };
    expect(atCrash).toEqual(empty);
    // It rejoins with a fresh pool: nothing cached, not even the system prompt.
    expect(atReady).toEqual(empty);
  });

  it('hands the failures to E6, which retries them', () => {
    const failed = records.filter((r) => r.outcome === OUTCOME.failed && r.attempt < 3);
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) {
      const retry = records.find(
        (r) => r.session === f.session && r.turn === f.turn && r.attempt === f.attempt + 1,
      );
      expect(retry, `session ${f.session} turn ${f.turn}`).toBeDefined();
      expect(retry!.arriveMs).toBe(f.endMs); // the 'immediate' policy
    }
    // Metrics counts each retry in the bucket it arrives in: the crash bucket's retries are the
    // unfinished attempts that ended in it.
    const retried = records.filter(
      (r) =>
        r.outcome !== OUTCOME.finished && r.attempt < 3 && r.endMs >= T && r.endMs < T + 10_000,
    );
    expect(scalarAt(j, 'retries', bucket(T), FLEET, 4)).toBe(retried.length);
  });

  it('routes around the replica from mark-down to Ready, then rejoins it cold', () => {
    const toIt = records.filter((r) => r.replica === CRASHED);
    expect(toIt.filter((r) => r.dispatchMs >= T + D && r.dispatchMs < READY_AT)).toEqual([]);
    const after = toIt.filter((r) => r.dispatchMs >= READY_AT);
    expect(after.length).toBeGreaterThan(0);
    // The first request after the rejoin finds nothing cached.
    const first = after.reduce((a, b) => (b.dispatchMs < a.dispatchMs ? b : a));
    expect(first.cachedTokens).toBe(0);
    expect(after.every((r) => r.outcome === OUTCOME.finished)).toBe(true);
  });

  it('shows the dip in Ready replicas and the failures on the crashed replica', () => {
    expect(scalarAt(j, 'readyReplicas', bucket(T - 10_000), FLEET, 4)).toBe(4);
    expect(scalarAt(j, 'readyReplicas', bucket(T + 60_000), FLEET, 4)).toBe(3);
    // Ready at T + 125 s: half of the [T + 120 s, T + 130 s) bucket.
    expect(scalarAt(j, 'readyReplicas', bucket(T + 120_000), FLEET, 4)).toBe(3.5);
    expect(scalarAt(j, 'readyReplicas', bucket(T + 130_000), FLEET, 4)).toBe(4);
    expect(scalarAt(j, 'failed', bucket(T), replicaSeries(CRASHED), 4)).toBeGreaterThan(0);
  });
});

describe('a fork in the full engine', () => {
  it('a crash added at the playhead matches a fresh run with the crash', () => {
    const until = T + 5 * MINUTE_MS;
    const fresh = fast.createDayRun(input([crash]));
    fresh.advance(T);
    const a = fresh.advance(until);
    const baseline = fast.createDayRun(input([]));
    baseline.advance(T);
    const fork = fast.restoreDayRun(input([crash]), baseline.checkpoint());
    const b = fork.advance(until);
    fork.assertInvariants();
    expect(b.replicaEvents.map((e) => e.state)).toEqual([
      REPLICA_STATE.crashed,
      REPLICA_STATE.down,
      REPLICA_STATE.loadingWeights,
      REPLICA_STATE.initializingEngine,
      REPLICA_STATE.ready,
    ]);
    expect(digestState(b)).toBe(digestState(a));
    expect(digestState(fork.state)).toBe(digestState(fresh.state));
  });
});
