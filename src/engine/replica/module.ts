// The replica engine module: event handlers, notice subscribers, bucket hook, and the calls other
// modules may make. index.ts documents the behaviour.

import type { Ctx, DayState } from '../core/index.ts';
import { NO_EVENT, PRIORITY, TOPIC, defineModule, type EngineModule } from '../core/index.ts';
import { clearStepDesc } from '../cost/index.ts';
import { blocksForTokens, createKvPool, kvUsedFrac, resetKvPool } from '../kv/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import type { RequestSlot } from '../shared/index.ts';
import { assertReplicaInvariants } from './invariants.ts';
import { flushNotices, noticeMark, pushNotice, resetNotices } from './notices.ts';
import { detachRequest, endRequest, generatedTokens } from './requests.ts';
import { accrue, resetAccrual, syncSpan, truncateSpan } from './span.ts';
import {
  EV_KICK,
  EV_STEP_END,
  MODE,
  PHASE,
  createReplicaSlice,
  ensureRequestCapacity,
  waitingCount,
  type ReplicaEngine,
} from './state.ts';
import { compose, finishStep, syncLevels, type SchedulerOptions, type StepInfo } from './steps.ts';

export interface ReplicaModuleOptions {
  /** Jump over decode-only spans in one event (default true). False gives one event per step. */
  eventJumping?: boolean;
  /** Called at every composed step or span (debugging, traces). Not part of the state. */
  onStep?: (info: StepInfo) => void;
}

function replicaOf(state: DayState, r: number): ReplicaEngine {
  const rep = state.replica.replicas[r];
  if (rep === undefined) throw new RangeError(`replica: no replica ${r}`);
  return rep;
}

function hasWork(rep: ReplicaEngine): boolean {
  return rep.running.length > 0 || waitingCount(rep) > 0;
}

/** Whether the request's whole sequence could ever run here (else it would block the queue). */
function canEverRun(state: DayState, rep: ReplicaEngine, s: RequestSlot): boolean {
  const t = state.shared.requests;
  const prompt = t.promptTokens[s]!;
  const output = Math.max(1, t.outputTarget[s]!);
  if (prompt + output > state.replica.limits.maxModelLen) return false;
  // Its last decode step holds KV for prompt + output - 1 tokens.
  return blocksForTokens(rep.pool, prompt + output - 1) <= rep.pool.totalBlocks;
}

function onDispatched(state: DayState, ctx: Ctx, s: RequestSlot, r: number): void {
  const t = state.shared.requests;
  const q = state.replica.req;
  const rep = replicaOf(state, r);
  ensureRequestCapacity(q, t.capacity);
  if (q.phase[s] !== PHASE.none) throw new Error(`replica: request slot ${s} dispatched twice`);
  if (!(t.promptTokens[s]! >= 1)) throw new RangeError(`replica: request slot ${s} has no prompt`);
  const mark = noticeMark();
  if (rep.state !== REPLICA_STATE.ready || !canEverRun(state, rep, s)) {
    // Connection reset (replica not Ready), or a sequence vLLM would refuse: fail at once.
    endRequest(state, s, OUTCOME.failed, ctx.nowMs, 0);
    flushNotices(ctx, mark);
    return;
  }
  q.phase[s] = PHASE.waiting;
  q.replica[s] = r;
  q.held[s] = 0;
  q.registered[s] = 0;
  q.computed[s] = 0;
  q.target[s] = t.promptTokens[s]!;
  q.generated[s] = 0;
  q.hitTokens[s] = 0;
  q.highWater[s] = 0;
  q.blocks[s]!.length = 0;
  // Bring a span's lazy state (and so its KV level) up to now before the levels move.
  syncSpan(state, r, ctx.nowMs);
  const wasEmpty = waitingCount(rep) === 0;
  rep.waiting.push(s);
  t.state[s] = REQUEST_STATE.waiting;
  pushNotice(TOPIC.requestState, s, REQUEST_STATE.waiting);
  if (rep.mode === MODE.idle) {
    rep.mode = MODE.kick;
    rep.ev = ctx.schedule(ctx.nowMs, EV_KICK, r);
  } else if (rep.mode === MODE.span && wasEmpty) {
    // A new waiting head may be admissible: stop the span after the step in flight.
    truncateSpan(state, ctx, r, EV_STEP_END);
  }
  syncLevels(state, r, ctx.nowMs);
  flushNotices(ctx, mark);
}

function onCancelled(state: DayState, ctx: Ctx, s: RequestSlot): void {
  const q = state.replica.req;
  if (s >= q.capacity || q.phase[s] === PHASE.none) return; // not held here
  const r = q.replica[s]!;
  const rep = replicaOf(state, r);
  const mark = noticeMark();
  syncSpan(state, r, ctx.nowMs);
  const wasRunning = q.phase[s] !== PHASE.waiting;
  const output = generatedTokens(state, s);
  const wasHead = detachRequest(state, rep, s);
  endRequest(state, s, OUTCOME.timedOut, ctx.nowMs, output);
  if (rep.mode === MODE.span && (wasRunning || wasHead)) truncateSpan(state, ctx, r, EV_STEP_END);
  if (rep.mode === MODE.kick && !hasWork(rep)) {
    ctx.cancel(rep.ev);
    rep.ev = NO_EVENT;
    rep.mode = MODE.idle;
  }
  syncLevels(state, r, ctx.nowMs);
  flushNotices(ctx, mark);
}

/** Connections reset: every request held fails, KV is wiped, stepping stops (02 §9). */
function failAll(state: DayState, ctx: Ctx, r: number): void {
  const rep = replicaOf(state, r);
  const q = state.replica.req;
  const mark = noticeMark();
  syncSpan(state, r, ctx.nowMs);
  accrue(state, r, ctx.nowMs);
  const doomed = [...rep.running, ...rep.waiting.slice(rep.waitHead)];
  const outputs = doomed.map((s) => generatedTokens(state, s));
  rep.running.length = 0;
  rep.waiting.length = 0;
  rep.waitHead = 0;
  rep.prefillCount = 0;
  for (const g of rep.groups) g.length = 0;
  clearStepDesc(rep.desc);
  rep.chunkSlot.length = 0;
  rep.chunkPrior.length = 0;
  rep.chunkTokens.length = 0;
  ctx.cancel(rep.ev);
  rep.ev = NO_EVENT;
  rep.mode = MODE.idle;
  resetAccrual(rep);
  resetKvPool(rep.pool);
  for (let i = 0; i < doomed.length; i++) {
    const s = doomed[i]!;
    q.held[s] = 0;
    q.registered[s] = 0;
    q.blocks[s]!.length = 0;
    endRequest(state, s, OUTCOME.failed, ctx.nowMs, outputs[i]!);
  }
  syncLevels(state, r, ctx.nowMs);
  flushNotices(ctx, mark);
}

function onReplicaState(state: DayState, ctx: Ctx, r: number, code: number): void {
  const rep = replicaOf(state, r);
  const was = rep.state;
  rep.state = code;
  if (code === REPLICA_STATE.ready) {
    // Rejoin after a crash with an empty cache, not the morning state (02 §9).
    if (was !== REPLICA_STATE.ready) {
      rep.pool = createKvPool(state.replica.limits);
      syncLevels(state, r, ctx.nowMs);
    }
    return;
  }
  if (was === REPLICA_STATE.ready || hasWork(rep) || rep.mode !== MODE.idle) failAll(state, ctx, r);
}

function onStepEnd(state: DayState, ctx: Ctx, r: number, handle: number, opts: SchedulerOptions) {
  resetNotices(); // events are never nested, so nothing can be pending
  const rep = replicaOf(state, r);
  if (rep.ev !== handle || (rep.mode !== MODE.step && rep.mode !== MODE.span)) {
    throw new Error(`replica ${r}: stale step end`);
  }
  rep.ev = NO_EVENT;
  const mark = noticeMark();
  if (rep.mode === MODE.span) syncSpan(state, r, Infinity);
  accrue(state, r, Infinity);
  finishStep(state, ctx, r);
  compose(state, ctx, r, opts);
  flushNotices(ctx, mark);
}

function onKick(state: DayState, ctx: Ctx, r: number, handle: number, opts: SchedulerOptions) {
  resetNotices();
  const rep = replicaOf(state, r);
  if (rep.ev !== handle || rep.mode !== MODE.kick) throw new Error(`replica ${r}: stale kick`);
  const mark = noticeMark();
  compose(state, ctx, r, opts);
  flushNotices(ctx, mark);
}

export function createReplicaModule(options: ReplicaModuleOptions = {}): EngineModule<'replica'> {
  const opts: SchedulerOptions = {
    jumping: options.eventJumping ?? true,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  };
  return defineModule({
    name: 'replica',
    init(state, ctx) {
      return createReplicaSlice(
        ctx.input.config,
        ctx.input.calibration,
        state.core.params.systemPromptTokens,
        state.shared.requests.capacity,
      );
    },
    events: [
      {
        kind: EV_STEP_END,
        name: 'replica.stepEnd',
        priority: PRIORITY.engine,
        handle: (state, ev, ctx) => onStepEnd(state, ctx, ev.a, ev.handle, opts),
      },
      {
        // Idle to busy: compose once the instant settles, so same-instant dispatches share a step.
        kind: EV_KICK,
        name: 'replica.kick',
        priority: PRIORITY.late,
        handle: (state, ev, ctx) => onKick(state, ctx, ev.a, ev.handle, opts),
      },
    ],
    notices: [
      {
        topic: TOPIC.requestDispatched,
        handle: (state, n, ctx) => onDispatched(state, ctx, n.a, n.b),
      },
      { topic: TOPIC.requestCancelled, handle: (state, n, ctx) => onCancelled(state, ctx, n.a) },
      {
        topic: TOPIC.replicaState,
        handle: (state, n, ctx) => onReplicaState(state, ctx, n.a, n.b),
      },
      {
        // A reader (E7's signal refresh) is about to sample meters: apply elapsed span state.
        topic: TOPIC.meterSync,
        handle: (state, n, ctx) => {
          if (n.a >= 0) syncSpan(state, n.a, ctx.nowMs);
          else
            for (let r = 0; r < state.replica.replicas.length; r++) syncSpan(state, r, ctx.nowMs);
        },
      },
    ],
    onBucketEnd(state, boundaryMs) {
      // Make the meters exact at the boundary before E9 (later in module order) reads them.
      for (let r = 0; r < state.replica.replicas.length; r++) {
        syncSpan(state, r, boundaryMs);
        accrue(state, r, boundaryMs);
      }
    },
    assertInvariants: assertReplicaInvariants,
  });
}

/** The replica scheduler with event-jumping on: the module E11 wires in. */
export const replicaModule = createReplicaModule();

// ----- Calls for other modules (downward calls; they may advance lazy span state) -----

/** Brings replica r's lazily applied span up to now. Call before reading its pool or requests. */
export function syncReplica(state: DayState, ctx: Ctx, r: number): void {
  syncSpan(state, r, ctx.nowMs);
}

/** Replica r's KV usage now: referenced blocks ÷ pool (vLLM kv_cache_usage_perc). */
export function replicaKvUsedFrac(state: DayState, ctx: Ctx, r: number): number {
  syncSpan(state, r, ctx.nowMs);
  return kvUsedFrac(replicaOf(state, r).pool);
}

/** Output tokens a request held by a replica has generated by now; 0 if not held. */
export function replicaGeneratedTokens(state: DayState, ctx: Ctx, s: RequestSlot): number {
  const q = state.replica.req;
  if (s >= q.capacity || q.phase[s] === PHASE.none) return 0;
  syncSpan(state, q.replica[s]!, ctx.nowMs);
  return generatedTokens(state, s);
}

export function replicaRunningCount(state: DayState, r: number): number {
  return replicaOf(state, r).running.length;
}

export function replicaWaitingCount(state: DayState, r: number): number {
  return waitingCount(replicaOf(state, r));
}

/** REPLICA_STATE code as this module last heard it. */
export function replicaStateCode(state: DayState, r: number): number {
  return replicaOf(state, r).state;
}
