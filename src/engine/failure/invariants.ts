// Failure slice invariants (00-build §7.1). O(replicas), so tests can run them after every event.
//
// - Every replica is in a known state, and its phase times follow from the phase it is in.
// - A Ready replica has no phase event. Every other replica has exactly one pending phase event,
//   the one that ends its phase, unless the phase ends at or after the day's end, where it has none
//   and stays put until the day ends. (Handlers reject any other phase event as stale, and every
//   path that replaces a phase event cancels the old one first, so one handle per replica is all.)
// - Recovery is ordered: crash <= phase start <= now <= phase end, and load start once loading.

import { NO_EVENT } from '../core/queue.ts';
import type { Ctx, DayState } from '../core/types.ts';
import { REPLICA_STATE, type ReplicaState } from '../results.ts';
import { isReplicaState } from './phases.ts';
import { phaseEndFor } from './slice.ts';

const S = REPLICA_STATE;

export function assertFailureInvariants(state: DayState, ctx: Ctx): void {
  const s = state.failure;
  const now = ctx.nowMs;
  const fail = (msg: string): never => {
    throw new Error(`Failure invariant (now ${now}): ${msg}`);
  };
  const n = ctx.input.config.replicas;
  if (s.replicas !== n) fail(`slice has ${s.replicas} replicas, config ${n}`);
  for (const a of [s.state, s.phaseStartMs, s.phaseEndMs, s.phaseEv, s.crashMs, s.loadStartMs]) {
    if (a.length !== n) fail('a per-replica array is mis-sized');
  }
  const { crashes, restarts, ignored } = s.stats;
  if (!(crashes >= 0 && restarts >= 0 && ignored >= 0)) fail('negative stats');

  for (let r = 0; r < n; r++) {
    const code = s.state[r]!;
    if (!isReplicaState(code)) fail(`replica ${r} is in unknown state ${code}`);
    const st = code as ReplicaState;
    const start = s.phaseStartMs[r]!;
    const end = s.phaseEndMs[r]!;
    const h = s.phaseEv[r]!;
    if (!(start >= ctx.dayStartMs && start <= now)) fail(`replica ${r} phase starts at ${start}`);

    if (st === S.ready) {
      if (end !== Infinity) fail(`replica ${r} is Ready with a phase end ${end}`);
      if (h !== NO_EVENT) fail(`replica ${r} is Ready with a phase event`);
      continue;
    }

    const crash = s.crashMs[r]!;
    if (!(crash <= start)) fail(`replica ${r} is recovering without a crash before ${start}`);
    const load = s.loadStartMs[r]!;
    const loading = st === S.loadingWeights || st === S.initializingEngine;
    if (loading ? !(load >= crash && load <= start) : !Number.isNaN(load)) {
      fail(`replica ${r} in state ${st} has load start ${load}`);
    }
    const expected = phaseEndFor(s, r, st, start);
    if (end !== expected) fail(`replica ${r} phase ends at ${end}, expected ${expected}`);
    if (!(end >= now)) fail(`replica ${r} phase ended at ${end} but is still pending`);
    if (end < ctx.dayEndMs) {
      if (!ctx.isPending(h)) fail(`replica ${r} in state ${st} has no pending phase event`);
    } else if (h !== NO_EVENT) {
      fail(`replica ${r} has a phase event past the day's end`);
    }
  }
}
