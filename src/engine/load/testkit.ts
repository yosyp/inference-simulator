// Test support for the load module's tests; engine code never imports it. A stub server stands in
// for the router and replicas (E7, E5): it takes each arrival, and ends it after the time a test
// policy chooses, with the outcome it chooses, or holds it until the client cancels or a crash.

import type { DayRunInput, Patch, SimConfig, TunableParams } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import {
  NO_EVENT,
  PRIORITY,
  TOPIC,
  createDayRunner,
  defineModule,
  type Ctx,
  type DayRunner,
  type DayState,
} from '../core/index.ts';
import { OUTCOME, REQUEST_STATE, type Outcome } from '../results.ts';
import { sharedModule } from '../shared/index.ts';
import { HOUR_MS, type DayIndex } from '../time.ts';
import { LOAD_TOPIC } from './ids.ts';
import { loadModule } from './module.ts';

/** What the stub does with one request. null times mean "never" (hold until cancelled). */
export interface StubAction {
  firstTokenAfterMs: number | null;
  endAfterMs: number | null;
  outcome: Outcome;
  /** End at once, inside the requestArrived notice (a router reject). */
  sync?: boolean;
}

export interface StubRequest {
  id: number;
  session: number;
  turn: number;
  attempt: number;
  kind: number;
  /** -1 until dispatched. */
  replica: number;
  promptTokens: number;
  nowMs: number;
  params: TunableParams;
}

export type StubPolicy = (req: StubRequest) => StubAction;

/** Finishes every request after serviceMs, with the first token at min(ttftMs, serviceMs). */
export function fixedService(serviceMs: number, ttftMs = 0): StubPolicy {
  const action: StubAction = {
    firstTokenAfterMs: Math.min(ttftMs, serviceMs),
    endAfterMs: serviceMs,
    outcome: OUTCOME.finished,
  };
  return () => action;
}

/** Flat log strides. */
export const ARRIVAL_STRIDE = 11;
export const END_STRIDE = 3;

export interface StubSlice {
  /** 1 while the stub holds the request (after taking it, until it ends). */
  held: number[];
  firstEv: number[];
  endEv: number[];
  endOutcome: number[];
  /** Flat [id, session, analyst, turn, attempt, kind, arriveMs, prompt, sys, outputTarget, prevReplica]. */
  arrivals: number[];
  /** Flat [id, outcome, endMs]. */
  ends: number[];
  /** Flat [id, atMs]. */
  firstTokens: number[];
  cancels: number[];
  /** Flat [session, SESSION_END]. */
  sessionEnds: number[];
}

declare module '../core/types.ts' {
  interface DayState {
    e6stub: StubSlice;
  }
}

const EV_FIRST = 900;
const EV_END = 901;

function endRequest(state: DayState, ctx: Ctx, slot: number, outcome: Outcome): void {
  const s = state.e6stub;
  const t = state.shared.requests;
  ctx.cancel(s.firstEv[slot] ?? NO_EVENT);
  ctx.cancel(s.endEv[slot] ?? NO_EVENT);
  s.held[slot] = 0;
  s.firstEv[slot] = NO_EVENT;
  s.endEv[slot] = NO_EVENT;
  t.endMs[slot] = ctx.nowMs;
  t.outcome[slot] = outcome;
  t.state[slot] = outcome;
  ctx.notify(TOPIC.requestState, slot, outcome);
  ctx.notify(TOPIC.requestEnded, slot, outcome);
}

/** The stub takes a request: it asks the policy what to do and schedules that. */
function take(state: DayState, ctx: Ctx, slot: number, policy: StubPolicy): void {
  const s = state.e6stub;
  const t = state.shared.requests;
  const id = t.id[slot]!;
  const action = policy({
    id,
    session: t.session[slot]!,
    turn: t.turn[slot]!,
    attempt: t.attempt[slot]!,
    kind: t.kind[slot]!,
    replica: t.replica[slot]!,
    promptTokens: t.promptTokens[slot]!,
    nowMs: ctx.nowMs,
    params: state.core.params,
  });
  if (action.sync) {
    endRequest(state, ctx, slot, action.outcome);
    return;
  }
  s.held[slot] = 1;
  s.firstEv[slot] =
    action.firstTokenAfterMs === null
      ? NO_EVENT
      : ctx.schedule(ctx.nowMs + action.firstTokenAfterMs, EV_FIRST, slot, id);
  s.endOutcome[slot] = action.outcome;
  s.endEv[slot] =
    action.endAfterMs === null
      ? NO_EVENT
      : ctx.schedule(ctx.nowMs + action.endAfterMs, EV_END, slot, id);
}

/**
 * The stub server. 'arrived': it stands in for the router and replicas, takes each request at
 * arrival, and sends it to replica session % replicas. 'dispatched': it stands in for the replicas
 * only, behind the real router (E7), taking what the router dispatches.
 */
export function stubServer(policy: StubPolicy, mode: 'arrived' | 'dispatched' = 'arrived') {
  return defineModule({
    name: 'e6stub',
    init: () => ({
      held: [],
      firstEv: [],
      endEv: [],
      endOutcome: [],
      arrivals: [],
      ends: [],
      firstTokens: [],
      cancels: [],
      sessionEnds: [],
    }),
    events: [
      {
        kind: EV_FIRST,
        name: 'e6stub.firstToken',
        priority: PRIORITY.engine,
        handle(state, ev, ctx) {
          const s = state.e6stub;
          const t = state.shared.requests;
          s.firstEv[ev.a] = NO_EVENT;
          t.firstTokenMs[ev.a] = ctx.nowMs;
          t.state[ev.a] = REQUEST_STATE.decode;
          s.firstTokens.push(ev.b, ctx.nowMs);
          ctx.notify(TOPIC.requestState, ev.a, REQUEST_STATE.decode);
          ctx.notify(TOPIC.firstToken, ev.a, t.replica[ev.a]);
        },
      },
      {
        kind: EV_END,
        name: 'e6stub.end',
        priority: PRIORITY.engine,
        handle(state, ev, ctx) {
          state.e6stub.endEv[ev.a] = NO_EVENT;
          endRequest(state, ctx, ev.a, state.e6stub.endOutcome[ev.a] as Outcome);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestArrived,
        handle(state, n, ctx) {
          const t = state.shared.requests;
          const slot = n.a;
          state.e6stub.arrivals.push(
            t.id[slot]!,
            t.session[slot]!,
            t.analyst[slot]!,
            t.turn[slot]!,
            t.attempt[slot]!,
            t.kind[slot]!,
            t.arriveMs[slot]!,
            t.promptTokens[slot]!,
            t.systemPromptTokens[slot]!,
            t.outputTarget[slot]!,
            t.prevReplica[slot]!,
          );
          if (mode !== 'arrived') return;
          t.replica[slot] = t.session[slot]! % ctx.input.config.replicas;
          t.dispatchMs[slot] = ctx.nowMs;
          take(state, ctx, slot, policy);
        },
      },
      {
        topic: TOPIC.requestDispatched,
        handle(state, n, ctx) {
          if (mode === 'dispatched') take(state, ctx, n.a, policy);
        },
      },
      {
        topic: TOPIC.requestCancelled,
        handle(state, n, ctx) {
          if (state.e6stub.held[n.a] !== 1) return; // still at the router, which ends it
          state.e6stub.cancels.push(state.shared.requests.id[n.a]!);
          endRequest(state, ctx, n.a, OUTCOME.timedOut);
        },
      },
      {
        // Every end, whoever ended the request (the stub, or the router's rejects and cancels).
        topic: TOPIC.requestEnded,
        handle(state, n) {
          const t = state.shared.requests;
          state.e6stub.ends.push(t.id[n.a]!, n.b, t.endMs[n.a]!);
        },
      },
      {
        topic: LOAD_TOPIC.sessionEnded,
        handle(state, n) {
          state.e6stub.sessionEnds.push(n.a, n.b);
        },
      },
    ],
    onInjected(state, event, ctx) {
      if (event.type !== 'crash') return;
      const t = state.shared.requests;
      for (let slot = 0; slot < t.capacity; slot++) {
        if (t.live[slot] === 1 && state.e6stub.held[slot] === 1) {
          endRequest(state, ctx, slot, OUTCOME.failed);
        }
      }
    },
  });
}

export function runner(policy: StubPolicy, assertEveryEvent = true): DayRunner {
  return createDayRunner([sharedModule, loadModule, stubServer(policy)], { assertEveryEvent });
}

export const TEST_DAY: DayIndex = 2;

/** A small population over a 08:00-12:00 ramp inside a 07:00-17:00 shift. */
export function testConfig(
  overrides: Partial<SimConfig> = {},
  tunable: Partial<TunableParams> = {},
): SimConfig {
  return {
    seed: 11,
    replicas: 2,
    analystsPerReplica: 10,
    shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
    diurnal: {
      knots: [
        [8 * HOUR_MS, 0.5],
        [10 * HOUR_MS, 1],
        [12 * HOUR_MS, 0],
      ],
      dayMultipliers: [1, 1, 1, 1, 1],
    },
    sessionsPerAnalystPerDay: 3,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 16,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    ...overrides,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 800,
      turnsPerSessionMean: 4,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 90_000,
      timeoutToFirstTokenMs: 60_000,
      retryPolicy: 'exponential',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 3,
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

/** The core only fingerprints calibration; the load module reads engine.maxModelLen. */
export function testCalibration(maxModelLen = 131_072): Calibration {
  return {
    schemaVersion: 1,
    status: 'provisional',
    engine: { maxModelLen },
  } as unknown as Calibration;
}

export function testInput(
  config: SimConfig = testConfig(),
  patches: Patch[] = [],
  opts: { day?: DayIndex; trackedAnalyst?: number | null; maxModelLen?: number } = {},
): DayRunInput {
  return {
    config,
    calibration: testCalibration(opts.maxModelLen),
    day: opts.day ?? TEST_DAY,
    patches,
    trackedAnalyst: opts.trackedAnalyst ?? null,
    detail: 'all',
  };
}

export interface Arrival {
  id: number;
  session: number;
  analyst: number;
  turn: number;
  attempt: number;
  kind: number;
  arriveMs: number;
  prompt: number;
  sys: number;
  output: number;
  prevReplica: number;
}

export function arrivals(state: DayState): Arrival[] {
  const a = state.e6stub.arrivals;
  const out: Arrival[] = [];
  for (let i = 0; i < a.length; i += ARRIVAL_STRIDE) {
    out.push({
      id: a[i]!,
      session: a[i + 1]!,
      analyst: a[i + 2]!,
      turn: a[i + 3]!,
      attempt: a[i + 4]!,
      kind: a[i + 5]!,
      arriveMs: a[i + 6]!,
      prompt: a[i + 7]!,
      sys: a[i + 8]!,
      output: a[i + 9]!,
      prevReplica: a[i + 10]!,
    });
  }
  return out;
}

/** Request id → [outcome, endMs]. */
export function ends(state: DayState): Map<number, [number, number]> {
  const e = state.e6stub.ends;
  const out = new Map<number, [number, number]>();
  for (let i = 0; i < e.length; i += END_STRIDE) out.set(e[i]!, [e[i + 1]!, e[i + 2]!]);
  return out;
}

/** Arrivals grouped by session, in arrival order. */
export function bySession(list: readonly Arrival[]): Map<number, Arrival[]> {
  const out = new Map<number, Arrival[]>();
  for (const a of list) {
    const s = out.get(a.session);
    if (s) s.push(a);
    else out.set(a.session, [a]);
  }
  return out;
}
