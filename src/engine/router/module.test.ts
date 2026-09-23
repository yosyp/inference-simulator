// The router inside a day runner: [shared, load stub (E6), router, replica stub (E5, plus E8's
// replica-state notices)]. Every run checks every module's invariants after every event.

import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch, SimConfig, TunableParams } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import {
  PRIORITY,
  TOPIC,
  createDayRunner,
  defineModule,
  digestState,
  setLevel,
  type CoreDayRun,
  type Ctx,
  type DayState,
  type RunnerOptions,
} from '../core/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE, type Outcome } from '../results.ts';
import { sharedModule } from '../shared/module.ts';
import { REQUEST_KIND, allocRequest, type RequestSlot } from '../shared/requests.ts';
import {
  EV_ROUTER_DISPATCH,
  admissionCap,
  admittedCount,
  affinityTarget,
  buildRing,
  routableSet,
  routerModule,
  sessionHash,
} from './index.ts';

// ---------------------------------------------------------------------------------------------
// Stubs

interface Arrival {
  atMs: number;
  session: number;
  /** The stub replica serves the request for this long. */
  serviceMs: number;
  turn?: number;
  attempt?: number;
}

interface Script {
  arrivals: Arrival[];
  /** Client cancellations (timeouts) by arrival index, sorted by time. */
  cancels?: { atMs: number; index: number }[];
  /** E8's replica-state notices, sorted by time. */
  replicaChanges?: { atMs: number; replica: number; state: number }[];
  /** Base KV fraction per replica from a time on, sorted by time. */
  kvSets?: { atMs: number; replica: number; frac: number }[];
  /** KV fraction each running request adds on its replica. */
  kvPerRequest?: number;
}

/** What the load stub saw, by arrival index. */
interface E7Load {
  next: number;
  nextCancel: number;
  slotOf: Int32Array;
  indexOf: Map<RequestSlot, number>;
  replica: Int16Array;
  dispatchMs: Float64Array;
  endMs: Float64Array;
  outcome: Uint8Array;
  /** Flat [topic, index, b] for each lifecycle notice. */
  log: number[];
}

interface E7Replica {
  state: Uint8Array;
  nextChange: number;
  nextKv: number;
  endEv: Map<RequestSlot, number>;
  running: Float64Array;
  kvBase: Float64Array;
}

declare module '../core/types.ts' {
  interface DayState {
    e7load: E7Load;
    e7replica: E7Replica;
  }
}

const K_ARRIVE = 900;
const K_CANCEL = 901;
const K_END = 910;
const K_REPLICA = 911;
const K_KV = 912;

function loadStub(script: Script) {
  const arrivals = script.arrivals;
  const cancels = script.cancels ?? [];
  const n = arrivals.length;
  const indexOf = (state: DayState, slot: RequestSlot) => state.e7load.indexOf.get(slot)!;
  return defineModule({
    name: 'e7load',
    init(_state, ctx) {
      if (n > 0) ctx.schedule(arrivals[0]!.atMs, K_ARRIVE);
      if (cancels.length > 0) ctx.schedule(cancels[0]!.atMs, K_CANCEL);
      return {
        next: 0,
        nextCancel: 0,
        slotOf: new Int32Array(n).fill(-1),
        indexOf: new Map(),
        replica: new Int16Array(n).fill(-1),
        dispatchMs: new Float64Array(n).fill(NaN),
        endMs: new Float64Array(n).fill(NaN),
        outcome: new Uint8Array(n),
        log: [],
      };
    },
    events: [
      {
        kind: K_ARRIVE,
        name: 'e7load.arrive',
        priority: PRIORITY.arrival,
        handle(state, _ev, ctx) {
          const l = state.e7load;
          const i = l.next++;
          const a = arrivals[i]!;
          const t = state.shared.requests;
          const slot = allocRequest(t);
          t.session[slot] = a.session;
          t.analyst[slot] = a.session;
          t.turn[slot] = a.turn ?? 1;
          t.attempt[slot] = a.attempt ?? 0;
          t.kind[slot] = REQUEST_KIND.turn;
          t.arriveMs[slot] = ctx.nowMs;
          t.promptTokens[slot] = 100;
          t.outputTarget[slot] = a.serviceMs;
          l.slotOf[i] = slot;
          l.indexOf.set(slot, i);
          if (l.next < n) ctx.schedule(arrivals[l.next]!.atMs, K_ARRIVE);
          ctx.notify(TOPIC.requestArrived, slot);
        },
      },
      {
        kind: K_CANCEL,
        name: 'e7load.cancel',
        priority: PRIORITY.client,
        handle(state, _ev, ctx) {
          const l = state.e7load;
          const c = cancels[l.nextCancel++]!;
          if (l.nextCancel < cancels.length) ctx.schedule(cancels[l.nextCancel]!.atMs, K_CANCEL);
          const slot = l.slotOf[c.index]!;
          if (slot >= 0) ctx.notify(TOPIC.requestCancelled, slot);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestDispatched,
        handle(state, nv, ctx) {
          const l = state.e7load;
          const i = indexOf(state, nv.a);
          l.replica[i] = nv.b;
          l.dispatchMs[i] = ctx.nowMs;
          l.log.push(TOPIC.requestDispatched, i, nv.b);
        },
      },
      {
        topic: TOPIC.requestState,
        handle(state, nv) {
          state.e7load.log.push(TOPIC.requestState, indexOf(state, nv.a), nv.b);
        },
      },
      {
        topic: TOPIC.requestEnded,
        handle(state, nv) {
          const l = state.e7load;
          const i = indexOf(state, nv.a);
          l.indexOf.delete(nv.a);
          l.slotOf[i] = -1;
          l.outcome[i] = nv.b;
          l.endMs[i] = state.shared.requests.endMs[nv.a]!;
          l.log.push(TOPIC.requestEnded, i, nv.b);
        },
      },
    ],
  });
}

function replicaStub(script: Script) {
  const changes = script.replicaChanges ?? [];
  const kvSets = script.kvSets ?? [];
  const kvPer = script.kvPerRequest ?? 0;
  const setKv = (state: DayState, r: number, ctx: Ctx) => {
    const s = state.e7replica;
    setLevel(
      state.shared.meters.replica.kvUsed[r]!,
      ctx.nowMs,
      s.kvBase[r]! + s.running[r]! * kvPer,
    );
  };
  const end = (state: DayState, slot: RequestSlot, outcome: Outcome, ctx: Ctx) => {
    const t = state.shared.requests;
    t.endMs[slot] = ctx.nowMs;
    t.outcome[slot] = outcome;
    t.state[slot] = outcome;
    ctx.notify(TOPIC.requestState, slot, outcome);
    ctx.notify(TOPIC.requestEnded, slot, outcome);
  };
  const release = (state: DayState, slot: RequestSlot, ctx: Ctx) => {
    const s = state.e7replica;
    const r = state.shared.requests.replica[slot]!;
    ctx.cancel(s.endEv.get(slot)!);
    s.endEv.delete(slot);
    s.running[r]!--;
    setKv(state, r, ctx);
  };
  return defineModule({
    name: 'e7replica',
    init(_state, ctx) {
      const n = ctx.input.config.replicas;
      if (changes.length > 0) ctx.schedule(changes[0]!.atMs, K_REPLICA);
      if (kvSets.length > 0) ctx.schedule(kvSets[0]!.atMs, K_KV);
      return {
        state: new Uint8Array(n).fill(REPLICA_STATE.ready),
        nextChange: 0,
        nextKv: 0,
        endEv: new Map(),
        running: new Float64Array(n),
        kvBase: new Float64Array(n),
      };
    },
    events: [
      {
        kind: K_END,
        name: 'e7replica.end',
        priority: PRIORITY.engine,
        handle(state, ev, ctx) {
          release(state, ev.a, ctx);
          end(state, ev.a, OUTCOME.finished, ctx);
        },
      },
      {
        kind: K_REPLICA,
        name: 'e7replica.state',
        priority: PRIORITY.infra,
        handle(state, _ev, ctx) {
          const s = state.e7replica;
          const c = changes[s.nextChange++]!;
          if (s.nextChange < changes.length) ctx.schedule(changes[s.nextChange]!.atMs, K_REPLICA);
          s.state[c.replica] = c.state;
          if (c.state === REPLICA_STATE.crashed) {
            // A crash fails every request in flight on the replica.
            for (const slot of [...s.endEv.keys()]) {
              if (state.shared.requests.replica[slot] !== c.replica) continue;
              release(state, slot, ctx);
              end(state, slot, OUTCOME.failed, ctx);
            }
          }
          ctx.notify(TOPIC.replicaState, c.replica, c.state);
        },
      },
      {
        kind: K_KV,
        name: 'e7replica.kv',
        priority: PRIORITY.engine,
        handle(state, _ev, ctx) {
          const s = state.e7replica;
          const k = kvSets[s.nextKv++]!;
          if (s.nextKv < kvSets.length) ctx.schedule(kvSets[s.nextKv]!.atMs, K_KV);
          s.kvBase[k.replica] = k.frac;
          setKv(state, k.replica, ctx);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestDispatched,
        handle(state, nv, ctx) {
          const s = state.e7replica;
          const [slot, r] = [nv.a, nv.b];
          // A dead replica refuses the connection: the request fails at once.
          if (s.state[r] !== REPLICA_STATE.ready) return end(state, slot, OUTCOME.failed, ctx);
          const t = state.shared.requests;
          t.state[slot] = REQUEST_STATE.waiting;
          ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.waiting);
          s.endEv.set(slot, ctx.schedule(ctx.nowMs + t.outputTarget[slot]!, K_END, slot));
          s.running[r]!++;
          setKv(state, r, ctx);
        },
      },
      {
        topic: TOPIC.requestCancelled,
        handle(state, nv, ctx) {
          if (!state.e7replica.endEv.has(nv.a)) return;
          release(state, nv.a, ctx);
          end(state, nv.a, OUTCOME.timedOut, ctx);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Harness

function config(
  replicas: number,
  tunable: Partial<TunableParams> = {},
  extra: Partial<SimConfig> = {},
): SimConfig {
  return {
    seed: 11,
    replicas,
    analystsPerReplica: 1,
    shift: { startMs: 0, endMs: 86_400_000 },
    diurnal: { knots: [[0, 1]], dayMultipliers: [1, 1, 1, 1, 1] },
    sessionsPerAnalystPerDay: 1,
    messageTokensSigma: 1,
    outputTokensSigma: 1,
    outputTokensMax: 1,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 128,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    ...extra,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 100,
      turnsPerSessionMean: 1,
      messageTokensMedian: 100,
      outputTokensMedian: 100,
      thinkTimeMedianMs: 1_000,
      timeoutToFirstTokenMs: null,
      retryPolicy: 'none',
      retryBaseMs: 1,
      retryCapMs: 1,
      maxRetries: 0,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
      ...tunable,
    },
  };
}

function input(cfg: SimConfig, patches: Patch[] = []): DayRunInput {
  return {
    config: cfg,
    calibration: {} as Calibration,
    day: 0,
    patches,
    trackedAnalyst: null,
    detail: 'tracked',
  };
}

function runnerFor(script: Script, options: RunnerOptions = {}) {
  return createDayRunner([sharedModule, loadStub(script), routerModule, replicaStub(script)], {
    assertEveryEvent: true,
    ...options,
  });
}

function start(
  script: Script,
  cfg: SimConfig,
  patches: Patch[] = [],
  options?: RunnerOptions,
): CoreDayRun {
  return runnerFor(script, options).createDayRun(input(cfg, patches));
}

const at = (atMs: number, session: number, serviceMs: number): Arrival => ({
  atMs,
  session,
  serviceMs,
});

/** `count` arrivals from `fromMs`, `gapMs` apart, sessions from `session`. */
function burst(
  fromMs: number,
  count: number,
  serviceMs: number,
  gapMs = 0,
  session = 0,
): Arrival[] {
  return Array.from({ length: count }, (_, i) => at(fromMs + i * gapMs, session + i, serviceMs));
}

function counts(values: ArrayLike<number>, n: number): number[] {
  const c = new Array<number>(n).fill(0);
  for (let i = 0; i < values.length; i++) if (values[i]! >= 0) c[values[i]!]!++;
  return c;
}

const set = (atMs: number, changes: Partial<TunableParams>): Patch => ({
  kind: 'set',
  atMs,
  changes,
});

// ---------------------------------------------------------------------------------------------
// Tests

describe('dispatch', () => {
  it('holds a request at the router for the overhead, then dispatches and counts it', () => {
    const script: Script = { arrivals: [...burst(1_000, 4, 5_000)] };
    const run = start(script, config(3));
    run.advance(1_001);
    const t = run.state.shared.requests;
    const l = run.state.e7load;
    for (let i = 0; i < 4; i++) expect(t.state[l.slotOf[i]!]).toBe(REQUEST_STATE.atRouter);
    expect(run.state.router.pending.size).toBe(4);
    expect(admittedCount(run.state.router)).toBe(4);
    expect([...l.replica]).toEqual([-1, -1, -1, -1]);

    run.advance(1_003);
    expect([...l.replica]).toEqual([0, 1, 2, 0]);
    expect([...l.dispatchMs]).toEqual([1_002, 1_002, 1_002, 1_002]);
    expect(t.replica[l.slotOf[3]!]).toBe(0);
    expect(t.state[l.slotOf[3]!]).toBe(REQUEST_STATE.waiting); // set by the replica
    expect([...run.state.router.outstanding]).toEqual([2, 1, 1]);
    const meters = run.state.shared.meters.replica.outstanding;
    expect(meters.map((m) => m.value)).toEqual([2, 1, 1]);

    run.advance(10_000);
    expect([...l.outcome]).toEqual(new Array<number>(4).fill(OUTCOME.finished));
    expect([...run.state.router.outstanding]).toEqual([0, 0, 0]);
    // The meters integrate exactly: two requests on replica 0 for 5 s each.
    expect(meters.map((m) => m.value)).toEqual([0, 0, 0]);
    expect(meters[0]!.area).toBe(2 * 5_000);
    expect(run.state.router.stats.admitted).toBe(4);
    run.assertInvariants();
  });

  it('chooses again at dispatch if its choice stopped being routable during the overhead', () => {
    const script: Script = {
      arrivals: [at(1_000, 0, 500), at(1_000, 1, 500), at(5_000, 2, 500)],
      replicaChanges: [
        { atMs: 1_500, replica: 1, state: REPLICA_STATE.down },
        { atMs: 5_500, replica: 0, state: REPLICA_STATE.down },
        { atMs: 5_500, replica: 2, state: REPLICA_STATE.down },
      ],
    };
    const run = start(script, config(3, {}, { routerOverheadMs: 1_000 }));
    run.advance(3_000);
    const l = run.state.e7load;
    expect([l.replica[0], l.replica[1]]).toEqual([0, 2]); // round-robin chose 1; it went down
    expect(run.state.router.stats.rerouted).toBe(1);
    // Request 2 chose replica 0 at 5 s; by dispatch at 6 s nothing is routable.
    run.advance(7_000);
    expect(l.outcome[2]).toBe(OUTCOME.rejected);
    expect(l.endMs[2]).toBe(6_000);
    expect(run.state.router.stats.rejectedNoReplica).toBe(1);
    run.assertInvariants();
  });
});

describe('delayed load signals (01 §5 concept 6)', () => {
  // Three long requests land on replicas 0-2 under round-robin; the policy then switches to
  // least-outstanding. The refresh at 10 s sees [1, 1, 1, 0]; a burst of 20 inside the next
  // interval all goes to replica 3, which looked idle.
  const script: Script = {
    arrivals: [
      ...burst(1_000, 3, 100_000),
      ...burst(11_000, 20, 100_000, 10, 100),
      at(21_000, 200, 100_000),
    ],
  };
  const patches = [set(2_000, { routingPolicy: 'leastOutstanding' })];

  it('piles a burst inside one refresh interval onto the replica that looked idle', () => {
    const run = start(script, config(4, { signalRefreshMs: 10_000 }), patches);
    run.advance(11_500);
    expect([...run.state.router.seenOutstanding]).toEqual([1, 1, 1, 0]);
    expect([...run.state.router.outstanding]).toEqual([1, 1, 1, 20]);
    expect(counts(run.state.e7load.replica.subarray(3, 23), 4)).toEqual([0, 0, 0, 20]);
    // The next refresh sees the pile, and the router moves away from it.
    run.advance(21_100);
    expect([...run.state.router.seenOutstanding]).toEqual([1, 1, 1, 20]);
    expect(run.state.e7load.replica[23]).not.toBe(3);
    run.assertInvariants();
  });

  it('spreads the same burst when signals are live', () => {
    const run = start(script, config(4, { signalRefreshMs: 0 }), patches);
    run.advance(11_500);
    const c = counts(run.state.e7load.replica.subarray(3, 23), 4);
    expect(c[3]).toBe(6);
    expect(
      Math.max(...run.state.router.outstanding) - Math.min(...run.state.router.outstanding),
    ).toBeLessThanOrEqual(1);
    expect(run.state.router.refreshEv).toBe(-1);
    run.assertInvariants();
  });

  it('moves the pending refresh when a patch changes signalRefreshMs', () => {
    const s: Script = { arrivals: [at(12_000, 0, 200_000), at(80_000, 1, 200_000)] };
    const run = start(s, config(2, { signalRefreshMs: 10_000 }), [
      set(15_000, { signalRefreshMs: 60_000 }),
      set(100_000, { signalRefreshMs: 0 }),
      set(120_000, { signalRefreshMs: 5_000 }),
    ]);
    run.advance(74_999);
    expect([...run.state.router.seenOutstanding]).toEqual([0, 0]); // 20 s refresh moved to 75 s
    run.advance(75_001);
    expect([...run.state.router.seenOutstanding]).toEqual([1, 0]);
    run.advance(100_001);
    expect(run.state.router.refreshEv).toBe(-1); // live signals: no refresh queued
    run.advance(124_999);
    expect(run.state.router.seenOutstanding[1]).toBe(0);
    run.advance(125_001);
    expect([...run.state.router.seenOutstanding]).toEqual([1, 1]);
    run.assertInvariants();
  });

  it('reads KV fractions from the meters at refresh time only', () => {
    const s: Script = {
      arrivals: [at(1_100, 0, 100), at(1_300, 1, 100), at(2_100, 2, 100)],
      kvSets: [
        { atMs: 500, replica: 0, frac: 0.8 },
        { atMs: 500, replica: 1, frac: 0.3 },
        { atMs: 500, replica: 2, frac: 0.5 },
        { atMs: 1_200, replica: 1, frac: 0.9 },
      ],
    };
    const run = start(s, config(3, { routingPolicy: 'kvUtilization', signalRefreshMs: 1_000 }));
    run.advance(3_000);
    // At 1.1 s and 1.3 s the snapshot from 1 s says replica 1 (0.3); at 2.1 s it says replica 2.
    expect([...run.state.e7load.replica]).toEqual([1, 1, 2]);
    expect([...run.state.router.seenKv]).toEqual([0.8, 0.9, 0.5]);
  });
});

describe('admission control (K9)', () => {
  it('caps admitted requests at the per-replica limit times routable replicas', () => {
    const script: Script = {
      arrivals: [
        ...burst(1_000, 12, 100_000),
        ...burst(7_000, 4, 100_000, 0, 100),
        ...burst(31_000, 4, 100_000, 0, 200),
      ],
      replicaChanges: [
        { atMs: 5_000, replica: 3, state: REPLICA_STATE.crashed },
        { atMs: 6_000, replica: 3, state: REPLICA_STATE.down },
        { atMs: 20_000, replica: 3, state: REPLICA_STATE.loadingWeights },
        { atMs: 25_000, replica: 3, state: REPLICA_STATE.initializingEngine },
        { atMs: 30_000, replica: 3, state: REPLICA_STATE.ready },
      ],
    };
    const run = start(script, config(4, { admissionLimitPerReplica: 2 }));
    const l = run.state.e7load;
    run.advance(2_000);
    expect(admissionCap(run.state)).toBe(8);
    expect(counts(l.outcome.subarray(0, 12), 7)[OUTCOME.rejected]).toBe(4);
    expect(l.outcome.subarray(8, 12).every((o) => o === OUTCOME.rejected)).toBe(true);
    expect(run.state.router.stats.rejectedByCap).toBe(4);

    // The crash fails replica 3's two requests; mark-down shrinks the cap to 6.
    run.advance(6_500);
    expect(admissionCap(run.state)).toBe(6);
    expect(admittedCount(run.state.router)).toBe(6);
    run.advance(8_000);
    expect(l.outcome.subarray(12, 16).every((o) => o === OUTCOME.rejected)).toBe(true);

    // Rejoin: the cap grows back to 8 and two of the next four get in.
    run.advance(29_999);
    expect(admissionCap(run.state)).toBe(6);
    run.advance(32_000);
    expect(admissionCap(run.state)).toBe(8);
    expect([...l.outcome.subarray(16, 20)]).toEqual([0, 0, OUTCOME.rejected, OUTCOME.rejected]);
    expect(admittedCount(run.state.router)).toBe(8);
    run.assertInvariants();
  });

  it('counts requests still waiting out the router overhead', () => {
    const run = start(
      { arrivals: burst(1_000, 5, 10_000) },
      config(1, { admissionLimitPerReplica: 2 }, { routerOverheadMs: 50 }),
    );
    run.advance(1_001);
    expect(run.state.router.pending.size).toBe(2);
    expect(run.state.router.stats.rejectedByCap).toBe(3);
  });

  it('admits everything when the limit is null, and a patch turns it on mid-day', () => {
    const script: Script = {
      arrivals: [...burst(1_000, 10, 100_000), ...burst(5_000, 3, 100_000, 0, 50)],
    };
    const run = start(script, config(2), [set(4_000, { admissionLimitPerReplica: 5 })]);
    run.advance(3_000);
    expect(admittedCount(run.state.router)).toBe(10);
    run.advance(6_000);
    expect(admittedCount(run.state.router)).toBe(10);
    expect(run.state.router.stats.rejectedByCap).toBe(3);
  });
});

describe('rejection and cancellation', () => {
  it('ends a rejected request at the router: endMs, outcome, state, then the notices', () => {
    const run = start(
      { arrivals: burst(1_000, 2, 10_000) },
      config(1, { admissionLimitPerReplica: 1 }),
    );
    run.advance(2_000);
    const l = run.state.e7load;
    expect(l.outcome[1]).toBe(OUTCOME.rejected);
    expect(l.endMs[1]).toBe(1_000);
    expect(l.replica[1]).toBe(-1);
    const forRequest1: number[] = [];
    for (let k = 0; k < l.log.length; k += 3)
      if (l.log[k + 1] === 1) forRequest1.push(l.log[k]!, l.log[k + 2]!);
    expect(forRequest1).toEqual([
      TOPIC.requestState,
      REQUEST_STATE.rejected,
      TOPIC.requestEnded,
      OUTCOME.rejected,
    ]);
  });

  it('rejects when no replica is routable, even without admission control', () => {
    const script: Script = {
      arrivals: [at(2_000, 0, 100)],
      replicaChanges: [{ atMs: 1_000, replica: 0, state: REPLICA_STATE.down }],
    };
    const run = start(script, config(1));
    run.advance(3_000);
    expect(run.state.e7load.outcome[0]).toBe(OUTCOME.rejected);
    expect(run.state.router.stats.rejectedNoReplica).toBe(1);
  });

  it('ends a request cancelled before dispatch as timedOut and drops its dispatch', () => {
    const dispatches: number[] = [];
    const script: Script = {
      arrivals: [at(1_000, 0, 5_000), at(1_000, 1, 5_000), at(1_000, 2, 5_000)],
      // 0 before dispatch; 1 after dispatch (the replica ends it); 2 after it finished (no-op).
      cancels: [
        { atMs: 1_050, index: 0 },
        { atMs: 3_000, index: 1 },
        { atMs: 9_000, index: 2 },
      ],
    };
    const run = start(script, config(2, {}, { routerOverheadMs: 100 }), [], {
      trace: (ev) => {
        if (ev.kind === EV_ROUTER_DISPATCH) dispatches.push(ev.a);
      },
    });
    run.advance(1_051);
    const l = run.state.e7load;
    expect(l.outcome[0]).toBe(OUTCOME.timedOut);
    expect(l.endMs[0]).toBe(1_050);
    expect(run.state.router.pending.size).toBe(2);
    expect(run.state.router.stats.cancelledAtRouter).toBe(1);
    run.advance(10_000);
    expect(dispatches.length).toBe(2); // the cancelled request's dispatch never fired
    expect([...l.replica]).toEqual([-1, 1, 0]);
    expect([l.outcome[1], l.endMs[1]]).toEqual([OUTCOME.timedOut, 3_000]);
    expect([l.outcome[2], l.endMs[2]]).toEqual([OUTCOME.finished, 6_100]);
    expect([...run.state.router.outstanding]).toEqual([0, 0]);
    expect(run.state.router.stats.cancelledAtRouter).toBe(1);
    const states0: number[] = [];
    for (let k = 0; k < l.log.length; k += 3)
      if (l.log[k + 1] === 0) states0.push(l.log[k]!, l.log[k + 2]!);
    expect(states0).toEqual([
      TOPIC.requestState,
      REQUEST_STATE.timedOut,
      TOPIC.requestEnded,
      OUTCOME.timedOut,
    ]);
    run.assertInvariants();
  });
});

describe('routable set from replica states', () => {
  const changes = [
    { atMs: 10_000, replica: 2, state: REPLICA_STATE.crashed },
    { atMs: 20_000, replica: 2, state: REPLICA_STATE.down },
    { atMs: 30_000, replica: 2, state: REPLICA_STATE.loadingWeights },
    { atMs: 45_000, replica: 2, state: REPLICA_STATE.initializingEngine },
    { atMs: 60_000, replica: 2, state: REPLICA_STATE.ready },
  ];
  const arrivals = Array.from({ length: 800 }, (_, i) => at(50 + i * 100, i % 40, 50));

  for (const routingPolicy of ['roundRobin', 'sessionAffinity'] as const) {
    it(`keeps sending to a crashed replica until mark-down, then again after Ready (${routingPolicy})`, () => {
      const run = start({ arrivals, replicaChanges: changes }, config(4, { routingPolicy }));
      run.advance(81_000);
      const l = run.state.e7load;
      const phase = (from: number, to: number) => {
        const out = { toCrashed: 0, failed: 0, finished: 0 };
        for (let i = 0; i < arrivals.length; i++) {
          if (!(l.dispatchMs[i]! >= from && l.dispatchMs[i]! < to)) continue;
          if (l.replica[i] === 2) out.toCrashed++;
          if (l.outcome[i] === OUTCOME.failed) out.failed++;
          if (l.outcome[i] === OUTCOME.finished) out.finished++;
        }
        return out;
      };
      const crashed = phase(10_000, 20_000);
      expect(crashed.toCrashed).toBeGreaterThan(15); // about a quarter of 100
      expect(crashed.failed).toBe(crashed.toCrashed);
      expect(phase(20_000, 60_000).toCrashed).toBe(0);
      const back = phase(60_000, 81_000);
      expect(back.toCrashed).toBeGreaterThan(30);
      expect(back.failed).toBe(0);
      run.assertInvariants();
    });
  }

  it('tracks the states it heard', () => {
    const run = start({ arrivals: [], replicaChanges: changes }, config(4));
    const seen = () => [...run.state.router.routable];
    run.advance(15_000);
    expect(seen()).toEqual([1, 1, 1, 1]);
    expect(run.state.router.seenState[2]).toBe(REPLICA_STATE.crashed);
    run.advance(25_000);
    expect(seen()).toEqual([1, 1, 0, 1]);
    expect([...run.state.router.routableList]).toEqual([0, 1, 3, -1]);
    run.advance(50_000);
    expect(seen()).toEqual([1, 1, 0, 1]);
    run.advance(61_000);
    expect(seen()).toEqual([1, 1, 1, 1]);
    expect(run.state.router.routableCount).toBe(4);
  });
});

describe('remapping through the router: 10k sessions, 8 replicas to 7 and back', () => {
  const N = 10_000;
  const phase = (fromMs: number) => Array.from({ length: N }, (_, s) => at(fromMs + s, s, 1));
  const script: Script = {
    arrivals: [...phase(1_000), ...phase(20_000), ...phase(40_000)],
    replicaChanges: [
      { atMs: 15_000, replica: 5, state: REPLICA_STATE.down },
      { atMs: 35_000, replica: 5, state: REPLICA_STATE.ready },
    ],
  };

  for (const [hashScheme, expected] of [
    ['modN', 7 / 8],
    ['consistent', 1 / 8],
  ] as const) {
    it(`${hashScheme} moves about ${expected === 1 / 8 ? '1/8' : '7/8'} of sessions each way`, () => {
      const cfg = config(8, { routingPolicy: 'sessionAffinity', hashScheme });
      const run = start(script, cfg);
      run.advance(52_000);
      const r = run.state.e7load.replica;
      const ring = buildRing(cfg.seed, 8, cfg.virtualNodesPerReplica);
      const all = routableSet(8, [0, 1, 2, 3, 4, 5, 6, 7]);
      const wrong = { target: 0, toDown: 0, notRestored: 0, movedFromOthers: 0 };
      let away = 0;
      let back = 0;
      for (let s = 0; s < N; s++) {
        if (r[s] !== affinityTarget(all, ring, hashScheme, sessionHash(cfg.seed, 0, s))) {
          wrong.target++;
        }
        if (r[s] !== r[N + s]) away++;
        if (r[N + s] !== r[2 * N + s]) back++;
        if (r[N + s] === 5) wrong.toDown++;
        if (r[2 * N + s] !== r[s]) wrong.notRestored++;
        if (hashScheme === 'consistent' && r[s] !== r[N + s] && r[s] !== 5) wrong.movedFromOthers++;
      }
      expect(wrong).toEqual({ target: 0, toDown: 0, notRestored: 0, movedFromOthers: 0 });
      expect(Math.abs(away / N - expected)).toBeLessThan(0.03);
      expect(back).toBe(away);
    }, 30_000); // 90k events, each followed by every module's invariants
  }
});

describe('determinism and checkpoints', () => {
  /** A seeded workload: sessions, cancellations, a crash and recovery, and a second crash. */
  function workload(seed: number): Script {
    let x = seed >>> 0;
    const rand = () => {
      x = (x + 0x6d2b79f5) >>> 0;
      let t = Math.imul(x ^ (x >>> 15), x | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const arrivals: Arrival[] = [];
    let tMs = 1_000;
    for (let i = 0; i < 2_500; i++) {
      tMs += Math.floor(rand() * 200);
      arrivals.push({
        atMs: tMs,
        session: Math.floor(rand() * 300),
        serviceMs: 200 + Math.floor(rand() * 4_000),
        turn: 1 + (i % 5),
      });
    }
    const cancels = arrivals
      .map((a, index) => ({ atMs: a.atMs + 1 + Math.floor(rand() * 6), index }))
      .filter((_, i) => i % 7 === 0)
      .sort((a, b) => a.atMs - b.atMs);
    return {
      arrivals,
      cancels,
      kvPerRequest: 0.05,
      replicaChanges: [
        { atMs: 60_000, replica: 1, state: REPLICA_STATE.crashed },
        { atMs: 70_000, replica: 1, state: REPLICA_STATE.down },
        { atMs: 75_000, replica: 1, state: REPLICA_STATE.loadingWeights },
        { atMs: 90_000, replica: 1, state: REPLICA_STATE.initializingEngine },
        { atMs: 120_000, replica: 1, state: REPLICA_STATE.ready },
        { atMs: 150_000, replica: 3, state: REPLICA_STATE.crashed },
        { atMs: 155_000, replica: 3, state: REPLICA_STATE.down },
        { atMs: 200_000, replica: 3, state: REPLICA_STATE.ready },
      ],
    };
  }
  const script = workload(5);
  const cfg = config(
    4,
    { routingPolicy: 'leastOutstanding', hashScheme: 'consistent', admissionLimitPerReplica: 6 },
    { routerOverheadMs: 3 },
  );
  const patches: Patch[] = [
    set(100_000, { routingPolicy: 'weighted', weightAffinity: 1.5 }),
    set(130_000, { signalRefreshMs: 5_000 }),
    set(180_000, { admissionLimitPerReplica: 3, routingPolicy: 'kvUtilization' }),
    set(220_000, { routingPolicy: 'sessionAffinity', hashScheme: 'modN' }),
  ];
  const END = 300_000;

  it('exercises every path the workload is built for', () => {
    const run = start(script, cfg, patches);
    run.advance(END);
    const st = run.state.router.stats;
    expect(st.rejectedByCap).toBeGreaterThan(0);
    expect(st.cancelledAtRouter).toBeGreaterThan(0);
    const c = counts(run.state.e7load.outcome, 9);
    expect(c[OUTCOME.failed]).toBeGreaterThan(0);
    expect(c[OUTCOME.timedOut]).toBeGreaterThan(st.cancelledAtRouter);
    expect(c[OUTCOME.finished]).toBeGreaterThan(1_000);
    expect(run.state.router.dispatched.size + run.state.router.pending.size).toBe(0);
    run.assertInvariants();
  });

  it('gives identical state for identical input', () => {
    const a = start(script, cfg, patches);
    const b = start(script, cfg, patches, { assertEveryEvent: false });
    a.advance(END);
    b.advance(END);
    expect(digestState(b.state)).toBe(digestState(a.state));
  });

  it('restores a checkpoint to the same end state as an uninterrupted run', () => {
    const whole = start(script, cfg, patches);
    whole.advance(END);
    const first = start(script, cfg, patches);
    first.advance(65_432); // mid-crash, with requests pending and outstanding
    expect(first.state.router.dispatched.size).toBeGreaterThan(0);
    const cp = first.checkpoint();
    for (let k = 0; k < 2; k++) {
      const resumed = runnerFor(script).restoreDayRun(input(cfg, patches), cp);
      resumed.advance(END);
      resumed.assertInvariants();
      expect(digestState(resumed.state)).toBe(digestState(whole.state));
    }
  });

  it('forks: restore then a new patch equals a fresh run with that patch', () => {
    const forkPatch = set(140_000, { routingPolicy: 'roundRobin', admissionLimitPerReplica: null });
    const fresh = start(script, cfg, [...patches, forkPatch]);
    fresh.advance(END);
    const base = start(script, cfg, patches);
    base.advance(140_000);
    const cp = base.checkpoint();
    const fork = runnerFor(script).restoreDayRun(input(cfg, [...patches, forkPatch]), cp);
    fork.advance(END);
    expect(digestState(fork.state)).toBe(digestState(fresh.state));
    base.advance(END);
    expect(digestState(base.state)).not.toBe(digestState(fresh.state));
  });
});

describe('invariants', () => {
  it('catch a count that drifts from the requests tracked', () => {
    const run = start({ arrivals: burst(1_000, 3, 10_000) }, config(2));
    run.advance(2_000);
    run.state.router.outstanding[0]!++;
    expect(() => run.assertInvariants()).toThrow(/outstanding/);
  });

  it('catch a routable set that disagrees with the states heard', () => {
    const run = start({ arrivals: [] }, config(2));
    run.advance(1_000);
    run.state.router.seenState[1] = REPLICA_STATE.down;
    expect(() => run.assertInvariants()).toThrow(/routable/);
  });

  it('catch a pending dispatch without an event', () => {
    const run = start({ arrivals: [at(1_000, 0, 100)] }, config(2, {}, { routerOverheadMs: 500 }));
    run.advance(1_100);
    const [slot] = [...run.state.router.pending.keys()];
    run.state.router.pending.set(slot!, 123_456);
    expect(() => run.assertInvariants()).toThrow(/dispatch event/);
  });
});
