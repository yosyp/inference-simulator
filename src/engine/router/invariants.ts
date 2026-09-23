// Router invariants (00-build §7.1), checked after every event in tests. O(replicas + requests the
// router holds).

import { NO_EVENT, type Ctx, type DayState } from '../core/index.ts';
import { REPLICA_STATE, REQUEST_STATE } from '../results.ts';

export function assertRouterInvariants(state: DayState, ctx: Ctx): void {
  const s = state.router;
  const t = state.shared.requests;
  const fail = (msg: string): never => {
    throw new Error(`Router invariant (now ${ctx.nowMs}): ${msg}`);
  };
  const n = s.replicas;

  // Outstanding counts equal the dispatched-but-not-ended requests tracked, and the meters mirror them.
  const counted = new Float64Array(n);
  for (const [slot, r] of s.dispatched) {
    if (!(r >= 0 && r < n)) fail(`slot ${slot} dispatched to unknown replica ${r}`);
    if (t.live[slot] !== 1) fail(`dispatched slot ${slot} is not a live request`);
    if (t.replica[slot] !== r) fail(`slot ${slot} tracked on ${r}, table says ${t.replica[slot]}`);
    counted[r]!++;
  }
  const levels = state.shared.meters.replica.outstanding;
  for (let r = 0; r < n; r++) {
    if (s.outstanding[r] !== counted[r]) {
      fail(`replica ${r} outstanding ${s.outstanding[r]}, tracked ${counted[r]}`);
    }
    if (levels[r]!.value !== s.outstanding[r]) {
      fail(`replica ${r} outstanding meter ${levels[r]!.value} != ${s.outstanding[r]}`);
    }
  }

  // Every pending dispatch is a live request at the router with a queued event, unless the router
  // overhead carries it past the day's end.
  const lateOk = ctx.dayEndMs - ctx.nowMs <= ctx.input.config.routerOverheadMs;
  for (const [slot, h] of s.pending) {
    if (s.dispatched.has(slot)) fail(`slot ${slot} is both pending and dispatched`);
    if (t.live[slot] !== 1) fail(`pending slot ${slot} is not a live request`);
    if (t.state[slot] !== REQUEST_STATE.atRouter) fail(`pending slot ${slot} is not atRouter`);
    if (h === NO_EVENT ? !lateOk : !ctx.isPending(h)) {
      fail(`pending slot ${slot} has no dispatch event`);
    }
  }

  // The routable set is consistent with the replica states heard.
  let c = 0;
  for (let r = 0; r < n; r++) {
    const seen = s.seenState[r];
    const routable = s.routable[r];
    if (routable !== 0 && routable !== 1) fail(`replica ${r} routable flag ${routable}`);
    if (seen === REPLICA_STATE.ready && routable !== 1) fail(`replica ${r} is Ready, not routable`);
    if (seen !== REPLICA_STATE.ready && seen !== REPLICA_STATE.crashed && routable !== 0) {
      fail(`replica ${r} is in state ${seen} but routable`);
    }
    if (routable === 1) {
      if (s.routableList[c] !== r) fail(`routable list slot ${c} is not replica ${r}`);
      c++;
    }
  }
  if (c !== s.routableCount) fail(`routableCount ${s.routableCount}, found ${c}`);
  if (!(s.rrLast >= -1 && s.rrLast < n)) fail(`rrLast ${s.rrLast} out of range`);

  // The next refresh is queued while signals are sampled.
  const every = state.core.params.signalRefreshMs;
  if (every > 0) {
    if (s.refreshEv === NO_EVENT ? ctx.dayEndMs - ctx.nowMs > every : !ctx.isPending(s.refreshEv)) {
      fail('lost the signal refresh event');
    }
  } else if (s.refreshEv !== NO_EVENT) {
    fail('a refresh is queued with live signals');
  }
}
