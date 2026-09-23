// Load-module invariants (00-build §7.1). Tests call them after every event; O(open sessions +
// request-table capacity).

import { NO_EVENT, type Ctx, type DayState } from '../core/index.ts';

export function assertLoadInvariants(state: DayState, ctx: Ctx): void {
  const L = state.load;
  const S = L.sessions;
  const t = state.shared.requests;
  const fail = (msg: string): never => {
    throw new Error(`Load invariant (now ${ctx.nowMs}): ${msg}`);
  };

  const exhausted = L.cursor.atMs === Infinity;
  if (exhausted !== (L.candidateEv === NO_EVENT)) fail('candidate event out of sync with cursor');
  if (!exhausted && !ctx.isPending(L.candidateEv)) fail('lost the next candidate event');

  let product = 1;
  for (let i = 0; i < L.spikeMult.length; i++) {
    const h = L.spikeEndEv[i]!;
    if (L.spikeActive[i] === 1) product *= L.spikeMult[i]!;
    else if (h !== NO_EVENT) fail(`ended spike ${i} still has an end event`);
    if (h !== NO_EVENT && !ctx.isPending(h)) fail(`spike ${i} lost its end event`);
  }
  if (product !== L.spikeProduct) fail('spike product out of date');

  let open = 0;
  const ids = new Set<number>();
  for (let r = 0; r < S.capacity; r++) {
    if (S.open[r] !== 1) {
      if (S.ev[r] !== NO_EVENT || S.timeoutEv[r] !== NO_EVENT || S.slot[r] !== -1) {
        fail(`closed session record ${r} holds events or a request`);
      }
      continue;
    }
    open++;
    const id = S.id[r]!;
    if (ids.has(id)) fail(`session ${id} is open twice`);
    ids.add(id);
    const slot = S.slot[r]!;
    const inFlight = slot >= 0;
    const pending = S.ev[r] !== NO_EVENT;
    // Every open session has exactly one of: a request in flight, or its next arrival pending.
    if (inFlight === pending)
      fail(`session ${id} has ${inFlight ? 'both' : 'neither'} a request and an arrival`);
    if (pending && !ctx.isPending(S.ev[r]!)) fail(`session ${id} lost its arrival event`);
    const timeout = S.timeoutEv[r]!;
    if (timeout !== NO_EVENT && (!inFlight || !ctx.isPending(timeout))) {
      fail(`session ${id} has a stray timeout`);
    }
    if (inFlight) {
      if (t.live[slot] !== 1 || L.recOfSlot[slot] !== r)
        fail(`session ${id} points at a dead slot`);
      if (
        t.session[slot] !== id ||
        t.turn[slot] !== S.turn[r] ||
        t.attempt[slot] !== S.attempt[r]
      ) {
        fail(`session ${id}'s request in slot ${slot} is not its current turn and attempt`);
      }
    }
    if (S.turn[r]! < 1 || S.turn[r]! > S.turns[r]!) fail(`session ${id} is on turn ${S.turn[r]}`);
  }
  if (open !== S.count) fail(`open count ${S.count}, found ${open}`);
  if (open + S.free.length !== S.capacity) fail('open + free session records != capacity');

  // Every live request belongs to exactly one open session, in flight on it: so no session has two.
  for (let s = 0; s < t.capacity; s++) {
    if (t.live[s] !== 1) continue;
    const r = s < L.recOfSlot.length ? L.recOfSlot[s]! : -1;
    if (r < 0 || S.open[r] !== 1 || S.slot[r] !== s) fail(`live request slot ${s} has no session`);
  }
}
