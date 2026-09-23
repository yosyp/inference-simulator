// Test harness for the replica module (tests only; E10 may reuse it). A driver module stands in for
// E6 and E7: it allocates requests from its own events, fills the fields they own, and notifies
// requestDispatched; it cancels on a client timeout or at a scripted time, and emits replicaState
// changes as E8 will. It records what each request ended with.
//
// The driver's slice is kept off DayState's type (tests only), so it is reached through driverOf.

import type { DayRunInput, SimConfig, TunableParams } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import {
  PRIORITY,
  TOPIC,
  createDayRunner,
  type CoreDayRun,
  type Ctx,
  type DayRunner,
  type DayState,
  type EngineModule,
  type RunnerOptions,
} from '../core/index.ts';
import { REQUEST_KIND, allocRequest, sharedModule } from '../shared/index.ts';
import type { DayIndex } from '../time.ts';
import { createReplicaModule, type ReplicaModuleOptions } from './module.ts';

export interface ScriptRequest {
  /** Dispatch time in ms after the day's start; with `after`, the delay after that request ends. */
  atMs: number;
  /** Index of an earlier script request whose end (any outcome) triggers this one. */
  after?: number;
  replica?: number;
  session?: number;
  turn?: number;
  promptTokens: number;
  outputTokens: number;
  systemPromptTokens?: number;
  /** Client timeout to first token, ms after dispatch (K8). */
  timeoutMs?: number;
  /** Cancel at this time (ms after the day's start) if still in flight, whatever its state. */
  cancelAtMs?: number;
}

export interface ScriptReplicaChange {
  atMs: number;
  replica: number;
  /** REPLICA_STATE code. */
  state: number;
}

export interface Script {
  requests: ScriptRequest[];
  replicaChanges?: ScriptReplicaChange[];
}

/** What each script request ended with (NaN / -1 when it never got there). */
export interface DriverSlice {
  script: ScriptRequest[];
  changes: ScriptReplicaChange[];
  followers: number[][];
  slotOf: number[];
  indexOfSlot: number[];
  timeoutEv: number[];
  dispatchMs: number[];
  firstTokenMs: number[];
  endMs: number[];
  outcome: number[];
  cachedTokens: number[];
  preemptions: number[];
  outputDone: number[];
  /** requestState codes each request passed through, in order. */
  states: number[][];
}

const K_DISPATCH = 900;
const K_TIMEOUT = 901;
const K_CANCEL_AT = 902;
const K_REPLICA = 903;

export function driverOf(state: DayState): DriverSlice {
  return (state as unknown as { e5driver: DriverSlice }).e5driver;
}

function dispatch(state: DayState, ctx: Ctx, i: number) {
  const d = driverOf(state);
  const r = d.script[i]!;
  const t = state.shared.requests;
  const s = allocRequest(t);
  const replica = r.replica ?? 0;
  t.session[s] = r.session ?? i;
  t.analyst[s] = 0;
  t.turn[s] = r.turn ?? 1;
  t.attempt[s] = 0;
  t.kind[s] = REQUEST_KIND.turn;
  t.arriveMs[s] = ctx.nowMs;
  t.promptTokens[s] = r.promptTokens;
  t.systemPromptTokens[s] = r.systemPromptTokens ?? 0;
  t.outputTarget[s] = r.outputTokens;
  t.prevReplica[s] = -1;
  t.dispatchMs[s] = ctx.nowMs;
  t.replica[s] = replica;
  d.slotOf[i] = s;
  while (d.indexOfSlot.length <= s) d.indexOfSlot.push(-1);
  d.indexOfSlot[s] = i;
  d.dispatchMs[i] = ctx.nowMs;
  if (r.timeoutMs !== undefined) {
    d.timeoutEv[i] = ctx.schedule(ctx.nowMs + r.timeoutMs, K_TIMEOUT, i);
  }
  ctx.notify(TOPIC.requestDispatched, s, replica);
}

function inFlight(state: DayState, i: number): number {
  const d = driverOf(state);
  const s = d.slotOf[i]!;
  return s >= 0 && Number.isNaN(d.endMs[i]!) && d.indexOfSlot[s] === i ? s : -1;
}

export function createDriverModule(script: Script): EngineModule {
  const module = {
    name: 'e5driver',
    init(_state: DayState, ctx: Ctx): DriverSlice {
      const n = script.requests.length;
      const followers: number[][] = Array.from({ length: n }, () => []);
      script.requests.forEach((r, i) => {
        if (r.after === undefined) ctx.schedule(ctx.dayStartMs + r.atMs, K_DISPATCH, i);
        else followers[r.after]!.push(i);
        if (r.cancelAtMs !== undefined) ctx.schedule(ctx.dayStartMs + r.cancelAtMs, K_CANCEL_AT, i);
      });
      const changes = script.replicaChanges ?? [];
      changes.forEach((c, i) => ctx.schedule(ctx.dayStartMs + c.atMs, K_REPLICA, i));
      const nan = () => new Array<number>(n).fill(NaN);
      return {
        script: structuredClone(script.requests),
        changes: structuredClone(changes),
        followers,
        slotOf: new Array<number>(n).fill(-1),
        indexOfSlot: [],
        timeoutEv: new Array<number>(n).fill(-1),
        dispatchMs: nan(),
        firstTokenMs: nan(),
        endMs: nan(),
        outcome: new Array<number>(n).fill(-1),
        cachedTokens: new Array<number>(n).fill(-1),
        preemptions: new Array<number>(n).fill(-1),
        outputDone: new Array<number>(n).fill(-1),
        states: Array.from({ length: n }, () => []),
      };
    },
    events: [
      {
        kind: K_DISPATCH,
        name: 'e5driver.dispatch',
        priority: PRIORITY.router,
        handle: (state: DayState, ev: { a: number }, ctx: Ctx) => dispatch(state, ctx, ev.a),
      },
      {
        kind: K_TIMEOUT,
        name: 'e5driver.timeout',
        priority: PRIORITY.client,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const d = driverOf(state);
          d.timeoutEv[ev.a] = -1;
          const s = inFlight(state, ev.a);
          if (s >= 0 && Number.isNaN(d.firstTokenMs[ev.a]!)) ctx.notify(TOPIC.requestCancelled, s);
        },
      },
      {
        kind: K_CANCEL_AT,
        name: 'e5driver.cancelAt',
        priority: PRIORITY.client,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const s = inFlight(state, ev.a);
          if (s >= 0) ctx.notify(TOPIC.requestCancelled, s);
        },
      },
      {
        kind: K_REPLICA,
        name: 'e5driver.replicaState',
        priority: PRIORITY.infra,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const c = driverOf(state).changes[ev.a]!;
          ctx.notify(TOPIC.replicaState, c.replica, c.state);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestState,
        handle(state: DayState, n: { a: number; b: number }) {
          const d = driverOf(state);
          const i = d.indexOfSlot[n.a];
          if (i !== undefined && i >= 0) d.states[i]!.push(n.b);
        },
      },
      {
        topic: TOPIC.firstToken,
        handle(state: DayState, n: { a: number }, ctx: Ctx) {
          const d = driverOf(state);
          const i = d.indexOfSlot[n.a]!;
          d.firstTokenMs[i] = state.shared.requests.firstTokenMs[n.a]!;
          ctx.cancel(d.timeoutEv[i]!);
          d.timeoutEv[i] = -1;
        },
      },
      {
        topic: TOPIC.requestEnded,
        handle(state: DayState, n: { a: number }, ctx: Ctx) {
          const d = driverOf(state);
          const t = state.shared.requests;
          const s = n.a;
          const i = d.indexOfSlot[s]!;
          d.endMs[i] = t.endMs[s]!;
          d.outcome[i] = t.outcome[s]!;
          d.cachedTokens[i] = t.cachedTokens[s]!;
          d.preemptions[i] = t.preemptions[s]!;
          d.outputDone[i] = t.outputDone[s]!;
          if (Number.isNaN(d.firstTokenMs[i]!)) d.firstTokenMs[i] = t.firstTokenMs[s]!;
          ctx.cancel(d.timeoutEv[i]!);
          d.timeoutEv[i] = -1;
          d.indexOfSlot[s] = -1;
          for (const f of d.followers[i]!) {
            ctx.schedule(ctx.nowMs + d.script[f]!.atMs, K_DISPATCH, f);
          }
        },
      },
    ],
  };
  return module as unknown as EngineModule;
}

export type ConfigOverrides = Omit<Partial<SimConfig>, 'tunable'> & {
  tunable?: Partial<TunableParams>;
};

export function testConfig(overrides: ConfigOverrides = {}): SimConfig {
  return {
    seed: 1,
    replicas: 1,
    analystsPerReplica: 1,
    shift: { startMs: 0, endMs: 24 * 3_600_000 },
    diurnal: { knots: [[0, 1]], dayMultipliers: [1, 1, 1, 1, 1] },
    sessionsPerAnalystPerDay: 1,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 3,
    virtualNodesPerReplica: 16,
    routerOverheadMs: 0,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: 10_000,
    histBucketMs: 60_000,
    ...overrides,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 0,
      turnsPerSessionMean: 1,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 60_000,
      timeoutToFirstTokenMs: null,
      retryPolicy: 'none',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 0,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
      ...overrides.tunable,
    },
  };
}

/** A calibration with a different engine block (e.g. a small KV pool). */
export function withEngine(cal: Calibration, engine: Partial<Calibration['engine']>): Calibration {
  return { ...cal, engine: { ...cal.engine, ...engine } };
}

export interface HarnessOptions extends ReplicaModuleOptions {
  config?: SimConfig;
  day?: DayIndex;
  runner?: RunnerOptions;
  /** Modules after the replica (e.g. a probe standing in for E9). */
  after?: readonly EngineModule[];
}

export function harnessInput(cal: Calibration, config: SimConfig, day: DayIndex = 0): DayRunInput {
  return { config, calibration: cal, day, patches: [], trackedAnalyst: null, detail: 'all' };
}

export interface ScriptRun {
  run: CoreDayRun;
  driver: () => DriverSlice;
  input: DayRunInput;
  runner: DayRunner;
}

/** A day run of [shared, driver, replica] over `script`. */
export function runScript(
  cal: Calibration,
  script: Script,
  options: HarnessOptions = {},
): ScriptRun {
  const {
    config = testConfig(),
    day = 0,
    runner: runnerOptions,
    after = [],
    ...replicaOptions
  } = options;
  const runner = createDayRunner(
    [sharedModule, createDriverModule(script), createReplicaModule(replicaOptions), ...after],
    runnerOptions,
  );
  const input = harnessInput(cal, config, day);
  const run = runner.createDayRun(input);
  return { run, driver: () => driverOf(run.state), input, runner };
}
