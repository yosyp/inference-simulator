// A scripted stand-in for E6, E7, E5, and E8: it plays a list of actions at chosen times,
// allocating requests, filling the shared request table, emitting the lifecycle topics, and
// writing meters and levels by hand. Test-only.

import { NO_EVENT } from '../../core/queue.ts';
import { PRIORITY, TOPIC } from '../../core/ids.ts';
import { setLevel } from '../../core/level.ts';
import type { Ctx, DayState, EngineModule } from '../../core/types.ts';
import {
  OUTCOME,
  REQUEST_STATE,
  type Outcome,
  type ReplicaState,
  type RequestState,
} from '../../results.ts';
import type { REPLICA_COUNTERS } from '../../shared/meters.ts';
import { allocRequest } from '../../shared/requests.ts';

export type Counter = (typeof REPLICA_COUNTERS)[number];
export type LevelName = 'kvUsed' | 'running' | 'waiting' | 'outstanding';

/** `at` is ms after the day's start. `key` names a request within the script. */
export type Action = { at: number } & (
  | {
      do: 'arrive';
      key: number;
      analyst?: number;
      session?: number;
      turn?: number;
      attempt?: number;
      promptTokens?: number;
      prevReplica?: number;
      /** Rejected by admission control inside the requestArrived notice (as E7 would). */
      rejectOnArrival?: boolean;
    }
  | { do: 'dispatch'; key: number; replica: number }
  | { do: 'state'; key: number; state: RequestState }
  | { do: 'first'; key: number }
  | {
      do: 'end';
      key: number;
      outcome: Outcome;
      outputDone?: number;
      cachedTokens?: number;
      preemptions?: number;
      /** Also announce the final state on requestState, as an ender may. Default true. */
      announceState?: boolean;
    }
  | { do: 'replica'; replica: number; state: ReplicaState }
  | { do: 'counter'; replica: number; counter: Counter; add: number }
  | { do: 'level'; replica: number; level: LevelName; value: number }
  | { do: 'abandon'; add: number }
);

export const SCRIPT_STUB = 'e9script';
const K_ACTION = 990;

interface ScriptSlice {
  /** key → request slot. */
  slots: number[];
  /** Slot to reject inside the next requestArrived notice, or -1. */
  rejectSlot: number;
}

function slice(state: DayState): ScriptSlice {
  return (state as unknown as Record<string, ScriptSlice>)[SCRIPT_STUB]!;
}

function endRequest(state: DayState, ctx: Ctx, slot: number, outcome: Outcome, announce: boolean) {
  const t = state.shared.requests;
  t.endMs[slot] = ctx.nowMs;
  t.outcome[slot] = outcome;
  t.state[slot] = outcome;
  if (announce) ctx.notify(TOPIC.requestState, slot, outcome);
  ctx.notify(TOPIC.requestEnded, slot, outcome);
}

function play(state: DayState, a: Action, ctx: Ctx): void {
  const s = slice(state);
  const t = state.shared.requests;
  const m = state.shared.meters;
  const now = ctx.nowMs;
  switch (a.do) {
    case 'arrive': {
      const slot = allocRequest(t);
      s.slots[a.key] = slot;
      t.session[slot] = a.session ?? a.key;
      t.analyst[slot] = a.analyst ?? 0;
      t.turn[slot] = a.turn ?? 1;
      t.attempt[slot] = a.attempt ?? 0;
      t.arriveMs[slot] = now;
      t.promptTokens[slot] = a.promptTokens ?? 1000;
      t.outputTarget[slot] = 100;
      t.prevReplica[slot] = a.prevReplica ?? -1;
      s.rejectSlot = a.rejectOnArrival ? slot : -1;
      ctx.notify(TOPIC.requestArrived, slot);
      return;
    }
    case 'dispatch': {
      const slot = s.slots[a.key]!;
      t.dispatchMs[slot] = now;
      t.replica[slot] = a.replica;
      ctx.notify(TOPIC.requestDispatched, slot, a.replica);
      t.state[slot] = REQUEST_STATE.waiting;
      ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.waiting);
      return;
    }
    case 'state': {
      const slot = s.slots[a.key]!;
      t.state[slot] = a.state;
      ctx.notify(TOPIC.requestState, slot, a.state);
      return;
    }
    case 'first': {
      const slot = s.slots[a.key]!;
      t.firstTokenMs[slot] = now;
      ctx.notify(TOPIC.firstToken, slot, t.replica[slot]!);
      return;
    }
    case 'end': {
      const slot = s.slots[a.key]!;
      t.outputDone[slot] = a.outputDone ?? 0;
      t.cachedTokens[slot] = a.cachedTokens ?? 0;
      t.preemptions[slot] = a.preemptions ?? 0;
      endRequest(state, ctx, slot, a.outcome, a.announceState ?? true);
      return;
    }
    case 'replica':
      ctx.notify(TOPIC.replicaState, a.replica, a.state);
      return;
    case 'counter':
      m.replica[a.counter][a.replica]! += a.add;
      return;
    case 'level':
      setLevel(m.replica[a.level][a.replica]!, now, a.value);
      return;
    case 'abandon':
      m.fleet.abandonedSessions += a.add;
      return;
  }
}

/** A module that plays `actions` (stable-sorted by time). Place it between shared and metrics. */
export function scriptStub(actions: readonly Action[]): EngineModule {
  const sorted = actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
    .map((x) => x.a);
  const module = {
    name: SCRIPT_STUB,
    init(_state: DayState, ctx: Ctx): ScriptSlice {
      sorted.forEach((a, i) => {
        if (ctx.schedule(ctx.dayStartMs + a.at, K_ACTION, i) === NO_EVENT) {
          throw new Error(`script action ${i} at ${a.at} is outside the day`);
        }
      });
      return { slots: [], rejectSlot: -1 };
    },
    events: [
      {
        kind: K_ACTION,
        name: 'e9script.action',
        priority: PRIORITY.engine,
        handle: (state: DayState, ev: { a: number }, ctx: Ctx) => play(state, sorted[ev.a]!, ctx),
      },
    ],
    notices: [
      {
        topic: TOPIC.requestArrived,
        handle(state: DayState, n: { a: number }, ctx: Ctx) {
          const s = slice(state);
          if (s.rejectSlot !== n.a) return;
          s.rejectSlot = -1;
          endRequest(state, ctx, n.a, OUTCOME.rejected, false);
        },
      },
    ],
  };
  return module as unknown as EngineModule;
}

/** A finished request's whole life: arrive, dispatch, prefill, first token, decode, end. */
export function servedRequest(o: {
  key: number;
  at: number;
  replica: number;
  ttftMs: number;
  e2eMs: number;
  outputDone: number;
  analyst?: number;
  attempt?: number;
}): Action[] {
  const { key, at, replica } = o;
  return [
    { at, do: 'arrive', key, analyst: o.analyst ?? 0, attempt: o.attempt ?? 0 },
    { at: at + 1, do: 'dispatch', key, replica },
    { at: at + 2, do: 'state', key, state: REQUEST_STATE.prefill },
    { at: at + o.ttftMs, do: 'first', key },
    { at: at + o.ttftMs, do: 'state', key, state: REQUEST_STATE.decode },
    { at: at + o.e2eMs, do: 'end', key, outcome: OUTCOME.finished, outputDone: o.outputDone },
  ];
}
