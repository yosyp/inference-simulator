// The failure module (WP E8; 02 §9). Module order: shared, load (E6), router (E7), replica (E5),
// failure, metrics (E9). It owns each replica's lifecycle state and announces every change with
// TOPIC.replicaState (a = replica, b = REPLICA_STATE). See index.ts for the timeline and choices.

import type { InjectedEvent, ReplicaId } from '../api.ts';
import {
  NO_EVENT,
  PRIORITY,
  TOPIC,
  defineModule,
  type Ctx,
  type DayState,
  type EventView,
} from '../core/index.ts';
import { REPLICA_STATE, type ReplicaState } from '../results.ts';
import { assertFailureInvariants } from './invariants.ts';
import { isLegalTransition } from './phases.ts';
import { createFailureSlice, phaseEndFor } from './slice.ts';

const S = REPLICA_STATE;

/** Failure event kinds (KIND_RANGES.failure). Each ends one phase; a = replica. */
export const EV_MARK_DOWN = 400; // Crashed → Down
export const EV_LOAD_START = 401; // Down → loadingWeights
export const EV_WEIGHTS_LOADED = 402; // loadingWeights → initializingEngine
export const EV_ENGINE_READY = 403; // initializingEngine → Ready

/** The event that ends each phase, by REPLICA_STATE code; 0 for Ready (no phase event). */
export const PHASE_END_KIND: Readonly<Record<ReplicaState, number>> = {
  [S.ready]: 0,
  [S.crashed]: EV_MARK_DOWN,
  [S.down]: EV_LOAD_START,
  [S.loadingWeights]: EV_WEIGHTS_LOADED,
  [S.initializingEngine]: EV_ENGINE_READY,
};

/** Moves replica r into `code` now: state, phase times, the phase-end event, then the notice. */
function enter(state: DayState, ctx: Ctx, r: ReplicaId, code: ReplicaState): void {
  const s = state.failure;
  const from = s.state[r]!;
  if (!isLegalTransition(from, code)) {
    throw new Error(`failure: replica ${r} cannot go from state ${from} to ${code}`);
  }
  const now = ctx.nowMs;
  if (code === S.crashed) {
    s.crashMs[r] = now;
    s.loadStartMs[r] = NaN;
  } else if (code === S.loadingWeights) {
    s.loadStartMs[r] = now;
  }
  const end = phaseEndFor(s, r, code, now);
  s.state[r] = code;
  s.phaseStartMs[r] = now;
  s.phaseEndMs[r] = end;
  // The previous phase's event has fired or was cancelled by the caller. schedule returns NO_EVENT
  // past the day's end: the replica then stays in this phase until the day ends.
  s.phaseEv[r] = code === S.ready ? NO_EVENT : ctx.schedule(end, PHASE_END_KIND[code], r);
  // State first, so subscribers (and replicaPhase) see the new phase inside the notice.
  ctx.notify(TOPIC.replicaState, r, code);
}

function onCrash(state: DayState, ctx: Ctx, r: ReplicaId): void {
  const s = state.failure;
  if (!(Number.isInteger(r) && r >= 0 && r < s.replicas)) {
    throw new RangeError(`failure: crash of replica ${r}, but there are ${s.replicas}`);
  }
  switch (s.state[r]) {
    case S.ready:
      s.stats.crashes++;
      break;
    case S.crashed:
      // Already dead and detection is under way; a second crash changes nothing.
      s.stats.ignored++;
      return;
    default:
      // The replacement died while recovering: start over from the crash.
      s.stats.restarts++;
      ctx.cancel(s.phaseEv[r]!);
      s.phaseEv[r] = NO_EVENT;
  }
  enter(state, ctx, r, S.crashed);
}

/** The handler for the event that ends phase `from`: the next phase starts now. */
function phaseEnd(from: ReplicaState, to: ReplicaState) {
  return (state: DayState, ev: Readonly<EventView>, ctx: Ctx): void => {
    const s = state.failure;
    const r = ev.a;
    if (s.phaseEv[r] !== ev.handle || s.state[r] !== from) {
      throw new Error(`failure: stale phase event for replica ${r} (state ${s.state[r]})`);
    }
    s.phaseEv[r] = NO_EVENT;
    enter(state, ctx, r, to);
  };
}

export const failureModule = defineModule({
  name: 'failure',
  init: (_state, ctx) => createFailureSlice(ctx.input, ctx.dayStartMs),
  events: [
    {
      kind: EV_MARK_DOWN,
      name: 'failure.markDown',
      priority: PRIORITY.infra,
      handle: phaseEnd(S.crashed, S.down),
    },
    {
      kind: EV_LOAD_START,
      name: 'failure.loadStart',
      priority: PRIORITY.infra,
      handle: phaseEnd(S.down, S.loadingWeights),
    },
    {
      kind: EV_WEIGHTS_LOADED,
      name: 'failure.weightsLoaded',
      priority: PRIORITY.infra,
      handle: phaseEnd(S.loadingWeights, S.initializingEngine),
    },
    {
      kind: EV_ENGINE_READY,
      name: 'failure.engineReady',
      priority: PRIORITY.infra,
      handle: phaseEnd(S.initializingEngine, S.ready),
    },
  ],
  onInjected(state, event: InjectedEvent, ctx) {
    if (event.type === 'crash') onCrash(state, ctx, event.replica);
  },
  assertInvariants: assertFailureInvariants,
});
