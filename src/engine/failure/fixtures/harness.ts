// Test harness for the failure module: a load stub (E6), a replica stub (E5), and a queue probe
// around the real shared, router (E7), failure, and metrics (E9) modules, in E11's module order.
// Test-only; nothing imports it outside *.test.ts files.

import type { DayRunInput, Patch, SimConfig, TunableParams } from '../../api.ts';
import type { Calibration } from '../../calibration.ts';
import {
  NO_EVENT,
  PRIORITY,
  TOPIC,
  createDayRunner,
  defineModule,
  setLevel,
  type Ctx,
  type DayState,
  type RunnerOptions,
} from '../../core/index.ts';
import { metricsModule } from '../../metrics/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE, type Outcome } from '../../results.ts';
import { routerModule } from '../../router/index.ts';
import { sharedModule } from '../../shared/module.ts';
import { REQUEST_KIND, allocRequest, type RequestSlot } from '../../shared/requests.ts';
import { DAY_MS, HOUR_MS, dayStartMs, type DayIndex } from '../../time.ts';
import { EV_ENGINE_READY, EV_MARK_DOWN, failureModule } from '../module.ts';

// ---------------------------------------------------------------------------------------------
// Load stub (E6 stand-in): arrival i at fromMs + i × gapMs is session i's only turn. A failed
// request is retried at once (attempt + 1), up to maxRetries, like an 'immediate' retry policy.

export interface LoadPlan {
  fromMs: number;
  gapMs: number;
  count: number;
  /** How long the replica stub serves each request. */
  serviceMs: number;
  maxRetries?: number;
}

/** One row per ended request, in end order. */
export interface EndRow {
  atMs: number;
  session: number;
  attempt: number;
  /** -1 if never dispatched. */
  replica: number;
  dispatchMs: number;
  outcome: Outcome;
}

export interface DispatchRow {
  atMs: number;
  session: number;
  attempt: number;
  replica: number;
}

export interface NoticeRow {
  atMs: number;
  replica: number;
  state: number;
}

export interface E8Load {
  next: number;
  ends: EndRow[];
  dispatches: DispatchRow[];
  /** Every replicaState notice, in emission order. */
  notices: NoticeRow[];
  /** Readable requestEnded and replicaState notices, in the order this module heard them. */
  log: string[];
  retries: number;
}

export interface E8Replica {
  /** 1 while the replica is Ready as last announced. */
  up: Uint8Array;
  held: Float64Array;
  endEv: Map<RequestSlot, number>;
  served: Float64Array;
  failedOnCrash: Float64Array;
  failedAtDispatch: Float64Array;
  /** Held requests failed per crash notice: [atMs, replica, count]. */
  wipes: number[][];
}

declare module '../../core/types.ts' {
  interface DayState {
    e8load: E8Load;
    e8replica: E8Replica;
    e8probe: Record<string, never>;
  }
}

const K_ARRIVE = 900;
const K_RETRY = 901;
const K_DONE = 910;

function newRequest(state: DayState, ctx: Ctx, session: number, attempt: number, plan: LoadPlan) {
  const t = state.shared.requests;
  const slot = allocRequest(t);
  t.session[slot] = session;
  t.analyst[slot] = session;
  t.turn[slot] = 1;
  t.attempt[slot] = attempt;
  t.kind[slot] = REQUEST_KIND.turn;
  t.arriveMs[slot] = ctx.nowMs;
  t.promptTokens[slot] = 100;
  t.outputTarget[slot] = plan.serviceMs;
  ctx.notify(TOPIC.requestArrived, slot);
}

export function loadStub(plan: LoadPlan) {
  const maxRetries = plan.maxRetries ?? 0;
  return defineModule({
    name: 'e8load',
    init(_state, ctx) {
      if (plan.count > 0) ctx.schedule(plan.fromMs, K_ARRIVE);
      return { next: 0, ends: [], dispatches: [], notices: [], log: [], retries: 0 };
    },
    events: [
      {
        kind: K_ARRIVE,
        name: 'e8load.arrive',
        priority: PRIORITY.arrival,
        handle(state, _ev, ctx) {
          const l = state.e8load;
          const i = l.next++;
          if (l.next < plan.count) ctx.schedule(plan.fromMs + l.next * plan.gapMs, K_ARRIVE);
          newRequest(state, ctx, i, 0, plan);
        },
      },
      {
        kind: K_RETRY,
        name: 'e8load.retry',
        priority: PRIORITY.arrival,
        handle(state, ev, ctx) {
          state.e8load.retries++;
          newRequest(state, ctx, ev.a, ev.b, plan);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestDispatched,
        handle(state, n, ctx) {
          const t = state.shared.requests;
          state.e8load.dispatches.push({
            atMs: ctx.nowMs,
            session: t.session[n.a]!,
            attempt: t.attempt[n.a]!,
            replica: n.b,
          });
        },
      },
      {
        topic: TOPIC.requestEnded,
        handle(state, n, ctx) {
          const t = state.shared.requests;
          const l = state.e8load;
          const session = t.session[n.a]!;
          const attempt = t.attempt[n.a]!;
          l.ends.push({
            atMs: ctx.nowMs,
            session,
            attempt,
            replica: t.replica[n.a]!,
            dispatchMs: t.dispatchMs[n.a]!,
            outcome: n.b as Outcome,
          });
          l.log.push(`${ctx.nowMs} ended ${session}/${attempt} ${n.b}`);
          // Never allocate inside a notice (shared/requests.ts): retry from an event.
          if (n.b === OUTCOME.failed && attempt < maxRetries) {
            ctx.schedule(ctx.nowMs, K_RETRY, session, attempt + 1);
          }
        },
      },
      {
        topic: TOPIC.replicaState,
        handle(state, n, ctx) {
          state.e8load.notices.push({ atMs: ctx.nowMs, replica: n.a, state: n.b });
          state.e8load.log.push(`${ctx.nowMs} replica ${n.a} -> ${n.b}`);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Replica stub (E5 stand-in): serves each request for its outputTarget ms. Leaving Ready fails
// everything it holds and empties the pool; a dispatch to a replica that isn't Ready fails at once.

function endRequest(state: DayState, ctx: Ctx, slot: RequestSlot, outcome: Outcome): void {
  const t = state.shared.requests;
  t.endMs[slot] = ctx.nowMs;
  t.outcome[slot] = outcome;
  t.state[slot] = outcome;
  ctx.notify(TOPIC.requestState, slot, outcome);
  ctx.notify(TOPIC.requestEnded, slot, outcome);
}

function syncLevels(state: DayState, ctx: Ctx, r: number): void {
  const m = state.shared.meters.replica;
  const held = state.e8replica.held[r]!;
  setLevel(m.running[r]!, ctx.nowMs, held);
  setLevel(m.kvUsed[r]!, ctx.nowMs, Math.min(1, held * 0.05));
}

export function replicaStub() {
  return defineModule({
    name: 'e8replica',
    init(_state, ctx) {
      const n = ctx.input.config.replicas;
      return {
        up: new Uint8Array(n).fill(1),
        held: new Float64Array(n),
        endEv: new Map(),
        served: new Float64Array(n),
        failedOnCrash: new Float64Array(n),
        failedAtDispatch: new Float64Array(n),
        wipes: [],
      };
    },
    events: [
      {
        kind: K_DONE,
        name: 'e8replica.done',
        priority: PRIORITY.engine,
        handle(state, ev, ctx) {
          const s = state.e8replica;
          const t = state.shared.requests;
          const slot = ev.a;
          const r = t.replica[slot]!;
          s.endEv.delete(slot);
          s.held[r]!--;
          s.served[r]!++;
          syncLevels(state, ctx, r);
          t.firstTokenMs[slot] = ctx.nowMs;
          t.outputDone[slot] = 1;
          ctx.notify(TOPIC.firstToken, slot, r);
          endRequest(state, ctx, slot, OUTCOME.finished);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestDispatched,
        handle(state, n, ctx) {
          const s = state.e8replica;
          const [slot, r] = [n.a, n.b];
          if (s.up[r] !== 1) {
            // The dead replica resets the connection.
            s.failedAtDispatch[r]!++;
            endRequest(state, ctx, slot, OUTCOME.failed);
            return;
          }
          const t = state.shared.requests;
          t.state[slot] = REQUEST_STATE.waiting;
          ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.waiting);
          s.endEv.set(slot, ctx.schedule(ctx.nowMs + t.outputTarget[slot]!, K_DONE, slot));
          s.held[r]!++;
          syncLevels(state, ctx, r);
        },
      },
      {
        topic: TOPIC.replicaState,
        handle(state, n, ctx) {
          const s = state.e8replica;
          const r = n.a;
          const wasUp = s.up[r] === 1;
          s.up[r] = n.b === REPLICA_STATE.ready ? 1 : 0;
          if (!wasUp || s.up[r] === 1) return;
          const t = state.shared.requests;
          const doomed = [...s.endEv.keys()].filter((slot) => t.replica[slot] === r);
          s.wipes.push([ctx.nowMs, r, doomed.length]);
          for (const slot of doomed) {
            ctx.cancel(s.endEv.get(slot)!);
            s.endEv.delete(slot);
          }
          s.held[r] = 0;
          syncLevels(state, ctx, r);
          for (const slot of doomed) {
            s.failedOnCrash[r]!++;
            endRequest(state, ctx, slot, OUTCOME.failed);
          }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Queue probe: after every event, scans the core queue (plain data) for failure events and checks
// that each replica has exactly the one its slice points to, or none when Ready or past the day.
// Invariant hooks must not change state, so the count of checks lives outside it.

export const probeChecks = { count: 0 };

export const failureQueueProbe = defineModule({
  name: 'e8probe',
  init: () => ({}),
  assertInvariants(state, ctx) {
    const q = state.core.queue;
    const f = state.failure;
    const count = new Array<number>(f.replicas).fill(0);
    for (let i = 0; i < q.size; i++) {
      const slot = q.heapSlot[i]!;
      const kind = q.kind[slot]!;
      if (kind >= EV_MARK_DOWN && kind <= EV_ENGINE_READY) count[q.a[slot]!]!++;
    }
    for (let r = 0; r < f.replicas; r++) {
      const want = f.state[r] !== REPLICA_STATE.ready && f.phaseEndMs[r]! < ctx.dayEndMs ? 1 : 0;
      if (count[r] !== want) {
        throw new Error(`probe: replica ${r} has ${count[r]} phase events queued, want ${want}`);
      }
      if ((want === 1) !== (f.phaseEv[r] !== NO_EVENT)) {
        throw new Error(`probe: replica ${r} phase handle disagrees with the queue`);
      }
    }
    probeChecks.count++;
  },
});

// ---------------------------------------------------------------------------------------------
// Inputs and runner

export const DAY: DayIndex = 1;
export const START = dayStartMs(DAY);
export const END = START + DAY_MS;

export function testConfig(
  tunable: Partial<TunableParams> = {},
  extra: Partial<SimConfig> = {},
): SimConfig {
  return {
    seed: 7,
    replicas: 4,
    analystsPerReplica: 1,
    shift: { startMs: 7 * HOUR_MS, endMs: 19 * HOUR_MS },
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
      // Live signals: no refresh event every second, which would dominate these runs.
      signalRefreshMs: 0,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
      ...tunable,
    },
  };
}

export function testInput(
  config: SimConfig,
  calibration: Calibration,
  patches: readonly Patch[] = [],
  day: DayIndex = DAY,
): DayRunInput {
  return { config, calibration, day, patches, trackedAnalyst: null, detail: 'tracked' };
}

export const crashAt = (atMs: number, replica: number): Patch => ({
  kind: 'event',
  atMs,
  event: { type: 'crash', replica },
});

/** The E11 order with stubs for E6 and E5, plus the queue probe last. */
export function failureRunner(plan: LoadPlan, options: RunnerOptions = {}) {
  return createDayRunner(
    [
      sharedModule,
      loadStub(plan),
      routerModule,
      replicaStub(),
      failureModule,
      metricsModule,
      failureQueueProbe,
    ],
    { assertEveryEvent: true, ...options },
  );
}
