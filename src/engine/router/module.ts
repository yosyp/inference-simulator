// The router module (WP E7; 02 §7; K9). Module order: shared, load (E6), router, replica (E5),
// failure (E8), metrics (E9).
//
// A request's path through the router:
// - requestArrived (E6): admission control first (K9), then a policy choice, then a dispatch event
//   after config.routerOverheadMs. The request stays atRouter until then.
// - Dispatch: set dispatchMs and replica, count it outstanding, notify requestDispatched. E5 sets
//   the state when it enqueues. If the chosen replica stopped being routable during the overhead,
//   the router chooses again.
// - requestEnded (whoever ends it): an outstanding request stops counting.
// - requestCancelled (E6) before dispatch: the router ends it as timedOut. After dispatch E5 does.
//
// Admission control counts every admitted request that has not ended, including the few waiting
// out the router overhead, exactly and without signal delay. The cap is admissionLimitPerReplica
// × routable replicas. Requests arriving with no routable replica are rejected too.
//
// The routable set follows replicaState notices (E8): Down, loadingWeights, and
// initializingEngine remove a replica; Ready adds it; Crashed changes nothing, because the router
// can't see a crash until mark-down. So a crashed replica keeps receiving traffic, and a retry
// storm can form (01 §5 concept 9; tab 6).
//
// Load signals: every signalRefreshMs the router snapshots each replica's outstanding count and KV
// used fraction (meters.replica.kvUsed, written by E5). Policies read only the snapshot (concept 6).
// A signalRefreshMs of 0 or less means live signals: a snapshot before every choice.
//
// Draws (K6): the session hash is u32(seed, sessionHash, day, session); a tie-break is
// u01(seed, routingTieBreak, day, session, turn, attempt, kind). Both use stable ids rather than the
// day-local request id, which shifts when retries reorder request creation.

import type { ReplicaId } from '../api.ts';
import {
  NO_EVENT,
  PRIORITY,
  TOPIC,
  addLevel,
  defineModule,
  type Ctx,
  type DayState,
  type EventHandle,
} from '../core/index.ts';
import { OUTCOME, REPLICA_STATE, type Outcome } from '../results.ts';
import { Source, u01 } from '../rng/index.ts';
import type { RequestSlot } from '../shared/requests.ts';
import { buildRing, rebuildRoutableList, sessionHash } from './hash.ts';
import { chooseReplica, policyCanTie, policyUsesHash, type RoutingView } from './policies.ts';
import { assertRouterInvariants } from './invariants.ts';

/** Router event kinds (KIND_RANGES.router). */
export const EV_ROUTER_DISPATCH = 200;
export const EV_ROUTER_REFRESH = 201;

export interface RouterStats {
  /** Requests that passed admission control. */
  admitted: number;
  /** Rejected by the fleet outstanding cap (K9). */
  rejectedByCap: number;
  /** Rejected because no replica was routable. */
  rejectedNoReplica: number;
  /** Chosen again at dispatch because the first choice stopped being routable. */
  rerouted: number;
  /** Ended as timedOut while waiting out the router overhead. */
  cancelledAtRouter: number;
}

export interface RouterSlice extends RoutingView {
  replicas: number;
  /** Last REPLICA_STATE heard per replica (ready at the day's start). */
  seenState: Uint8Array;
  /** Exact dispatched-and-not-ended count per replica, mirrored into meters.replica.outstanding. */
  outstanding: Float64Array;
  /** Dispatched and not ended: slot → replica. */
  dispatched: Map<RequestSlot, ReplicaId>;
  /** Admitted and waiting out the router overhead: slot → dispatch event (NO_EVENT past day end). */
  pending: Map<RequestSlot, EventHandle>;
  /** Next signal refresh; NO_EVENT with live signals or past the day's end. */
  refreshEv: EventHandle;
  stats: RouterStats;
}

declare module '../core/types.ts' {
  interface DayState {
    router: RouterSlice;
  }
}

/** Requests admitted and not yet ended: pending dispatch plus outstanding (the K9 count). */
export function admittedCount(s: RouterSlice): number {
  return s.pending.size + s.dispatched.size;
}

/** The fleet outstanding cap now, or Infinity when admission control is off. */
export function admissionCap(state: DayState): number {
  const limit = state.core.params.admissionLimitPerReplica;
  return limit === null ? Infinity : limit * state.router.routableCount;
}

/** Copies live outstanding counts and KV fractions into the signals policies read. */
export function refreshSignals(state: DayState, ctx: Ctx): void {
  // Replicas integrate KV usage lazily inside a step span; bring it up to now before sampling.
  ctx.notify(TOPIC.meterSync, -1);
  const s = state.router;
  const kv = state.shared.meters.replica.kvUsed;
  for (let r = 0; r < s.replicas; r++) {
    s.seenOutstanding[r] = s.outstanding[r]!;
    s.seenKv[r] = kv[r]!.value;
  }
}

/** The replica the current policy picks for this request now, or -1 if none is routable. */
function choose(state: DayState, slot: RequestSlot, ctx: Ctx): ReplicaId {
  const s = state.router;
  const p = state.core.params;
  const t = state.shared.requests;
  const seed = ctx.input.config.seed;
  const day = ctx.input.day;
  if (p.signalRefreshMs <= 0) refreshSignals(state, ctx);
  const hash = policyUsesHash(p) ? sessionHash(seed, day, t.session[slot]!) : 0;
  const tieU = policyCanTie(p)
    ? u01(
        seed,
        Source.routingTieBreak,
        day,
        t.session[slot],
        t.turn[slot],
        t.attempt[slot],
        t.kind[slot],
      )
    : 0;
  const r = chooseReplica(s, p, hash, tieU);
  if (p.routingPolicy === 'roundRobin' && r >= 0) s.rrLast = r;
  return r;
}

/** Ends a request the router still holds (reject, or cancel before dispatch). */
function endAtRouter(state: DayState, slot: RequestSlot, outcome: Outcome, ctx: Ctx): void {
  const t = state.shared.requests;
  t.endMs[slot] = ctx.nowMs;
  t.outcome[slot] = outcome;
  t.state[slot] = outcome; // OUTCOME codes are the terminal REQUEST_STATE codes
  ctx.notify(TOPIC.requestState, slot, outcome);
  ctx.notify(TOPIC.requestEnded, slot, outcome);
}

function onArrived(state: DayState, slot: RequestSlot, ctx: Ctx): void {
  const s = state.router;
  if (s.routableCount === 0) {
    s.stats.rejectedNoReplica++;
    endAtRouter(state, slot, OUTCOME.rejected, ctx);
    return;
  }
  if (admittedCount(s) >= admissionCap(state)) {
    s.stats.rejectedByCap++;
    endAtRouter(state, slot, OUTCOME.rejected, ctx);
    return;
  }
  s.stats.admitted++;
  const r = choose(state, slot, ctx);
  const at = ctx.nowMs + ctx.input.config.routerOverheadMs;
  s.pending.set(slot, ctx.schedule(at, EV_ROUTER_DISPATCH, slot, r));
}

function onDispatch(state: DayState, slot: RequestSlot, chosen: ReplicaId, ctx: Ctx): void {
  const s = state.router;
  if (!s.pending.delete(slot)) throw new Error(`router: dispatch for slot ${slot}, not pending`);
  let r = chosen;
  if (s.routable[r] !== 1) {
    s.stats.rerouted++;
    r = choose(state, slot, ctx);
    if (r < 0) {
      s.stats.rejectedNoReplica++;
      endAtRouter(state, slot, OUTCOME.rejected, ctx);
      return;
    }
  }
  const t = state.shared.requests;
  t.dispatchMs[slot] = ctx.nowMs;
  t.replica[slot] = r;
  s.outstanding[r]!++;
  addLevel(state.shared.meters.replica.outstanding[r]!, ctx.nowMs, 1);
  s.dispatched.set(slot, r);
  // Counted before the notice: E5 may end the request inside it (e.g. on a crashed replica).
  ctx.notify(TOPIC.requestDispatched, slot, r);
}

function onEnded(state: DayState, slot: RequestSlot, ctx: Ctx): void {
  const s = state.router;
  const r = s.dispatched.get(slot);
  if (r !== undefined) {
    s.dispatched.delete(slot);
    s.outstanding[r]!--;
    addLevel(state.shared.meters.replica.outstanding[r]!, ctx.nowMs, -1);
    return;
  }
  // Another module ended a request still waiting out the router overhead: drop its dispatch.
  const h = s.pending.get(slot);
  if (h !== undefined) {
    ctx.cancel(h);
    s.pending.delete(slot);
  }
}

function onCancelled(state: DayState, slot: RequestSlot, ctx: Ctx): void {
  const s = state.router;
  const h = s.pending.get(slot);
  if (h === undefined) return; // dispatched (E5 ends it) or already ended
  ctx.cancel(h);
  s.pending.delete(slot);
  s.stats.cancelledAtRouter++;
  endAtRouter(state, slot, OUTCOME.timedOut, ctx);
}

function onReplicaState(state: DayState, r: ReplicaId, code: number): void {
  const s = state.router;
  if (!(r >= 0 && r < s.replicas)) throw new Error(`router: replicaState for unknown replica ${r}`);
  s.seenState[r] = code;
  let next = s.routable[r]!;
  if (code === REPLICA_STATE.ready) next = 1;
  else if (code !== REPLICA_STATE.crashed) next = 0; // down, loadingWeights, initializingEngine
  if (next !== s.routable[r]) {
    s.routable[r] = next;
    rebuildRoutableList(s);
  }
}

/** Moves the next refresh to one interval from now; none with live signals. */
function scheduleRefresh(state: DayState, ctx: Ctx): void {
  const s = state.router;
  const every = state.core.params.signalRefreshMs;
  ctx.cancel(s.refreshEv);
  s.refreshEv = every > 0 ? ctx.schedule(ctx.nowMs + every, EV_ROUTER_REFRESH) : NO_EVENT;
}

export const routerModule = defineModule({
  name: 'router',
  init(state, ctx) {
    const cfg = ctx.input.config;
    const n = cfg.replicas;
    const s: RouterSlice = {
      replicas: n,
      routable: new Uint8Array(n).fill(1),
      routableList: new Int32Array(n),
      routableCount: 0,
      ring: buildRing(cfg.seed, n, cfg.virtualNodesPerReplica),
      seenOutstanding: new Float64Array(n),
      seenKv: new Float64Array(n),
      rrLast: -1,
      seenState: new Uint8Array(n).fill(REPLICA_STATE.ready),
      outstanding: new Float64Array(n),
      dispatched: new Map(),
      pending: new Map(),
      refreshEv: NO_EVENT,
      stats: {
        admitted: 0,
        rejectedByCap: 0,
        rejectedNoReplica: 0,
        rerouted: 0,
        cancelledAtRouter: 0,
      },
    };
    rebuildRoutableList(s);
    // The morning snapshot is all zeros; the first refresh is one interval in.
    const every = state.core.params.signalRefreshMs;
    if (every > 0) s.refreshEv = ctx.schedule(ctx.dayStartMs + every, EV_ROUTER_REFRESH);
    return s;
  },
  events: [
    {
      kind: EV_ROUTER_DISPATCH,
      name: 'router.dispatch',
      priority: PRIORITY.router,
      handle: (state, ev, ctx) => onDispatch(state, ev.a, ev.b, ctx),
    },
    {
      // After the instant's dispatches, so a snapshot sees the router's settled counts.
      kind: EV_ROUTER_REFRESH,
      name: 'router.refresh',
      priority: PRIORITY.router + 1,
      handle(state, _ev, ctx) {
        state.router.refreshEv = NO_EVENT;
        refreshSignals(state, ctx);
        scheduleRefresh(state, ctx);
      },
    },
  ],
  notices: [
    { topic: TOPIC.requestArrived, handle: (state, n, ctx) => onArrived(state, n.a, ctx) },
    { topic: TOPIC.requestCancelled, handle: (state, n, ctx) => onCancelled(state, n.a, ctx) },
    { topic: TOPIC.requestEnded, handle: (state, n, ctx) => onEnded(state, n.a, ctx) },
    { topic: TOPIC.replicaState, handle: (state, n) => onReplicaState(state, n.a, n.b) },
  ],
  onParams(state, changes, ctx) {
    if (changes.signalRefreshMs !== undefined) scheduleRefresh(state, ctx);
  },
  assertInvariants: (state, ctx) => assertRouterInvariants(state, ctx),
});
