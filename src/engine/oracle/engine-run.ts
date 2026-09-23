// The real engine on an oracle input: shared, a scripted client driver in E6's place, E7's router,
// E5's replica (event-jumping on by default), and E9's metrics, in 00-build §4 module order. The
// driver creates each request at its scripted time and sends it to the router (requestArrived); it
// arms the timeout to first token at arrival, cancels on it or at a scripted time, emits replica
// state changes as E8 will, and records what each request did.

import {
  PRIORITY,
  TOPIC,
  createDayRunner,
  type Ctx,
  type DayState,
  type EngineModule,
} from '../core/index.ts';
import { metricsModule } from '../metrics/index.ts';
import { MODE, createReplicaModule, type StepInfo } from '../replica/index.ts';
import { routerModule } from '../router/index.ts';
import { REPLICA_COUNTERS, REQUEST_KIND, allocRequest, sharedModule } from '../shared/index.ts';
import {
  emptyCounters,
  emptyRequestResults,
  poolContents,
  type OracleInput,
  type RequestResults,
  type RunResults,
  type StepRecord,
} from './types.ts';

const K_ARRIVE = 910;
const K_TIMEOUT = 911;
const K_CANCEL_AT = 912;
const K_REPLICA = 913;

/** The driver's slice (tests only, so kept off DayState's type; reach it through driverOf). */
export interface DriverSlice {
  res: RequestResults;
  slotOf: number[];
  /** Request index by slot while the request is in flight; -1 otherwise. */
  indexOfSlot: number[];
  timeoutEv: number[];
  /** Requests not yet ended (including those that haven't arrived). */
  open: number;
  /** Replica changes still to come. */
  changesLeft: number;
}

export function driverOf(state: DayState): DriverSlice {
  return (state as unknown as { e10driver: DriverSlice }).e10driver;
}

function inFlight(d: DriverSlice, i: number): number {
  const s = d.slotOf[i]!;
  return s >= 0 && Number.isNaN(d.res.endMs[i]!) && d.indexOfSlot[s] === i ? s : -1;
}

function arrive(input: OracleInput, state: DayState, ctx: Ctx, i: number): void {
  const d = driverOf(state);
  const spec = input.requests[i]!;
  const t = state.shared.requests;
  const s = allocRequest(t);
  t.session[s] = spec.session;
  t.analyst[s] = 0;
  t.turn[s] = spec.turn;
  t.attempt[s] = 0;
  t.kind[s] = REQUEST_KIND.turn;
  t.arriveMs[s] = ctx.nowMs;
  t.promptTokens[s] = spec.promptTokens;
  t.systemPromptTokens[s] = spec.systemPromptTokens;
  t.outputTarget[s] = spec.outputTokens;
  t.prevReplica[s] = -1;
  d.slotOf[i] = s;
  while (d.indexOfSlot.length <= s) d.indexOfSlot.push(-1);
  d.indexOfSlot[s] = i;
  d.res.arriveMs[i] = ctx.nowMs;
  if (spec.timeoutMs !== undefined) {
    d.timeoutEv[i] = ctx.schedule(ctx.nowMs + spec.timeoutMs, K_TIMEOUT, i);
  }
  ctx.notify(TOPIC.requestArrived, s);
}

function onEnded(input: OracleInput, followers: number[][], state: DayState, ctx: Ctx, s: number) {
  const d = driverOf(state);
  const t = state.shared.requests;
  const i = d.indexOfSlot[s]!;
  const r = d.res;
  r.endMs[i] = t.endMs[s]!;
  r.outcome[i] = t.outcome[s]!;
  r.dispatchMs[i] = t.dispatchMs[s]!;
  r.replica[i] = t.replica[s]!;
  r.cachedTokens[i] = t.cachedTokens[s]!;
  r.preemptions[i] = t.preemptions[s]!;
  r.outputDone[i] = t.outputDone[s]!;
  ctx.cancel(d.timeoutEv[i]!);
  d.timeoutEv[i] = -1;
  d.indexOfSlot[s] = -1;
  d.open--;
  for (const f of followers[i]!) ctx.schedule(ctx.nowMs + input.requests[f]!.atMs, K_ARRIVE, f);
}

export function createClientDriver(input: OracleInput): EngineModule {
  const n = input.requests.length;
  const followers: number[][] = input.requests.map(() => []);
  input.requests.forEach((spec, i) => {
    if (spec.after !== undefined) followers[spec.after]!.push(i);
  });
  const module = {
    name: 'e10driver',
    init(_state: DayState, ctx: Ctx): DriverSlice {
      input.requests.forEach((spec, i) => {
        if (spec.after === undefined) ctx.schedule(ctx.dayStartMs + spec.atMs, K_ARRIVE, i);
        if (spec.cancelAtMs !== undefined) {
          ctx.schedule(ctx.dayStartMs + spec.cancelAtMs, K_CANCEL_AT, i);
        }
      });
      input.replicaChanges.forEach((c, k) => ctx.schedule(ctx.dayStartMs + c.atMs, K_REPLICA, k));
      return {
        res: emptyRequestResults(n),
        slotOf: new Array<number>(n).fill(-1),
        indexOfSlot: [],
        timeoutEv: new Array<number>(n).fill(-1),
        open: n,
        changesLeft: input.replicaChanges.length,
      };
    },
    events: [
      {
        kind: K_ARRIVE,
        name: 'e10driver.arrive',
        priority: PRIORITY.arrival,
        handle: (state: DayState, ev: { a: number }, ctx: Ctx) => arrive(input, state, ctx, ev.a),
      },
      {
        kind: K_TIMEOUT,
        name: 'e10driver.timeout',
        priority: PRIORITY.client,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const d = driverOf(state);
          d.timeoutEv[ev.a] = -1;
          const s = inFlight(d, ev.a);
          if (s >= 0 && Number.isNaN(d.res.firstTokenMs[ev.a]!)) {
            ctx.notify(TOPIC.requestCancelled, s);
          }
        },
      },
      {
        kind: K_CANCEL_AT,
        name: 'e10driver.cancelAt',
        priority: PRIORITY.client,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const s = inFlight(driverOf(state), ev.a);
          if (s >= 0) ctx.notify(TOPIC.requestCancelled, s);
        },
      },
      {
        kind: K_REPLICA,
        name: 'e10driver.replicaState',
        priority: PRIORITY.infra,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          driverOf(state).changesLeft--;
          const c = input.replicaChanges[ev.a]!;
          ctx.notify(TOPIC.replicaState, c.replica, c.state);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestState,
        handle(state: DayState, no: { a: number; b: number }, ctx: Ctx) {
          const i = driverOf(state).indexOfSlot[no.a];
          if (i !== undefined && i >= 0) driverOf(state).res.transitions[i]!.push(ctx.nowMs, no.b);
        },
      },
      {
        topic: TOPIC.firstToken,
        handle(state: DayState, no: { a: number }, ctx: Ctx) {
          const d = driverOf(state);
          const i = d.indexOfSlot[no.a]!;
          d.res.firstTokenMs[i] = state.shared.requests.firstTokenMs[no.a]!;
          ctx.cancel(d.timeoutEv[i]!);
          d.timeoutEv[i] = -1;
        },
      },
      {
        topic: TOPIC.requestEnded,
        handle: (state: DayState, no: { a: number }, ctx: Ctx) =>
          onEnded(input, followers, state, ctx, no.a),
      },
    ],
  };
  return module as unknown as EngineModule;
}

export interface EngineRunOptions {
  /** E5's event-jumping (default true). False runs one event per engine step. */
  eventJumping?: boolean;
  /** Record every composed step or span. */
  trace?: boolean;
  /** Check every module's invariants after every event (slow). */
  assertEveryEvent?: boolean;
  /** Replace E5's module (mutation tests). */
  replicaModule?: EngineModule;
}

/**
 * Runs the input's day on the engine, a minute at a time, until every request has ended, every
 * replica change has happened, and every replica is idle.
 */
export function runEngine(input: OracleInput, options: EngineRunOptions = {}): RunResults {
  const raw: StepInfo[] = [];
  let live: DayState | null = null;
  // Chunks name request slots, which are reused; record request indices instead.
  const record = (info: StepInfo) => {
    const index = driverOf(live!).indexOfSlot;
    raw.push({ ...info, chunks: info.chunks.map((v, k) => (k % 3 === 0 ? index[v]! : v)) });
  };
  const replica =
    options.replicaModule ??
    createReplicaModule({
      eventJumping: options.eventJumping ?? true,
      ...(options.trace ? { onStep: record } : {}),
    });
  const runner = createDayRunner(
    [sharedModule, createClientDriver(input), routerModule, replica, metricsModule],
    { assertEveryEvent: options.assertEveryEvent ?? false },
  );
  const run = runner.createDayRun({
    config: input.config,
    calibration: input.cal,
    day: input.day,
    patches: [],
    trackedAnalyst: null,
    detail: 'all',
  });
  live = run.state;
  const idle = () => run.state.replica.replicas.every((rep) => rep.mode === MODE.idle);
  for (let t = run.state.core.dayStartMs; !run.done;) {
    t += 60_000;
    run.advance(t);
    const d = driverOf(run.state);
    if (d.open === 0 && d.changesLeft === 0 && idle()) break;
  }
  run.assertInvariants();
  const counters = emptyCounters(input.config.replicas);
  const m = run.state.shared.meters.replica;
  for (const c of REPLICA_COUNTERS) counters[c] = Array.from(m[c]);
  const steps: StepRecord[] = raw.map((s) => ({
    replica: s.replica,
    clock: s.clock,
    atMs: s.atMs,
    durationMs: s.durationMs,
    steps: s.steps,
    decodeSeqs: s.decodeSeqs,
    decodeContextTokens: s.decodeContextTokens,
    chunks: s.chunks,
    preempted: s.preempted,
  }));
  return {
    dayStartMs: run.state.core.dayStartMs,
    requests: driverOf(run.state).res,
    counters,
    pools: run.state.replica.replicas.map((rep) => poolContents(rep.pool)),
    steps,
  };
}
