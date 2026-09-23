// A synthetic workload in place of E6, E7, E5, and E8, for long runs: open-loop arrivals over a
// window, each request's fate and timings drawn from a keyed hash of its id, meters and levels
// written as a replica would, and an optional crash-and-recover cycle. Test-only; the numbers are
// shapes, not a model.

import { PRIORITY, TOPIC } from '../../core/ids.ts';
import { addLevel, setLevel } from '../../core/level.ts';
import type { Ctx, DayState, EngineModule } from '../../core/types.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE, type Outcome } from '../../results.ts';
import { allocRequest } from '../../shared/requests.ts';

export interface SynthOptions {
  /** Mean gap between arrivals. */
  gapMs: number;
  /** Arrival window, ms after the day's start. */
  fromMs: number;
  toMs: number;
  analysts: number;
  /** One replica crashes at `atMs` (after the day's start) and is Ready again 90 s later. */
  crash?: { replica: number; atMs: number };
}

export const SYNTH_STUB = 'e9synth';
const K_ARRIVE = 991;
const K_STAGE = 992;
const K_CRASH = 993;
const STAGE = { dispatch: 0, prefill: 1, first: 2, end: 3, fail: 4, timeout: 5 } as const;
const CRASH_STEPS: readonly [number, number][] = [
  [0, REPLICA_STATE.crashed],
  [10_000, REPLICA_STATE.down],
  [20_000, REPLICA_STATE.loadingWeights],
  [60_000, REPLICA_STATE.initializingEngine],
  [90_000, REPLICA_STATE.ready],
];

interface SynthSlice {
  ready: Uint8Array;
  running: Float64Array;
  rejectSlot: number;
}

function slice(state: DayState): SynthSlice {
  return (state as unknown as Record<string, SynthSlice>)[SYNTH_STUB]!;
}

function mix32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Keyed uniform in (0, 1) for request i, draw k. */
export function u01(i: number, k: number): number {
  return (mix32(mix32(mix32(0x5eed ^ k) ^ i) ^ Math.imul(k, 0x9e3779b9)) + 0.5) / 4294967296;
}

/** A request's scripted fate and timings, from its id alone. */
export function plan(i: number) {
  const v = u01(i, 4);
  const fate: Outcome =
    v < 0.04
      ? OUTCOME.rejected
      : v < 0.09
        ? OUTCOME.timedOut
        : v < 0.12
          ? OUTCOME.failed
          : OUTCOME.finished;
  return {
    fate,
    attempt: u01(i, 2) < 0.1 ? 1 : 0,
    turn: 1 + Math.floor(u01(i, 8) * 4),
    promptTokens: 500 + Math.floor(u01(i, 9) * 4000),
    waitMs: Math.floor(u01(i, 5) * 80),
    ttftMs: 80 + Math.round(3000 * u01(i, 6) ** 2),
    outputs: 1 + Math.floor(u01(i, 7) * 300),
    tpotMs: 15 + Math.round(u01(i, 10) * 30),
  };
}

function setKv(state: DayState, ctx: Ctx, r: number): void {
  const running = slice(state).running[r]!;
  setLevel(state.shared.meters.replica.kvUsed[r]!, ctx.nowMs, Math.min(1, running / 24));
}

function end(state: DayState, ctx: Ctx, slot: number, outcome: Outcome, announce: boolean): void {
  const t = state.shared.requests;
  t.endMs[slot] = ctx.nowMs;
  t.outcome[slot] = outcome;
  t.state[slot] = outcome;
  if (announce) ctx.notify(TOPIC.requestState, slot, outcome);
  ctx.notify(TOPIC.requestEnded, slot, outcome);
}

function arrive(state: DayState, i: number, ctx: Ctx, o: SynthOptions): void {
  const t = state.shared.requests;
  const p = plan(i);
  const slot = allocRequest(t);
  if (t.id[slot] !== i) throw new Error(`synth: request ${i} got id ${t.id[slot]}`);
  const analyst = Math.floor(u01(i, 1) * o.analysts);
  t.session[slot] = analyst * 64 + Math.floor(i / 97);
  t.analyst[slot] = analyst;
  t.turn[slot] = p.turn;
  t.attempt[slot] = p.attempt;
  t.arriveMs[slot] = ctx.nowMs;
  t.promptTokens[slot] = p.promptTokens;
  t.outputTarget[slot] = p.outputs;
  t.prevReplica[slot] = p.turn > 1 ? Math.floor(u01(i, 11) * ctx.input.config.replicas) : -1;
  const s = slice(state);
  s.rejectSlot = p.fate === OUTCOME.rejected ? slot : -1;
  ctx.notify(TOPIC.requestArrived, slot);
  if (p.fate !== OUTCOME.rejected) ctx.schedule(ctx.nowMs + 2, K_STAGE, slot, STAGE.dispatch);
  const next = ctx.nowMs + Math.max(1, Math.round(o.gapMs * 2 * u01(i, 0)));
  if (next < ctx.dayStartMs + o.toMs) ctx.schedule(next, K_ARRIVE, i + 1);
}

function stage(state: DayState, slot: number, st: number, ctx: Ctx): void {
  const t = state.shared.requests;
  const m = state.shared.meters.replica;
  const s = slice(state);
  const i = t.id[slot]!;
  const p = plan(i);
  const now = ctx.nowMs;
  let r = t.replica[slot]!;
  switch (st) {
    case STAGE.dispatch: {
      const R = s.ready.length;
      const pick = Math.floor(u01(i, 3) * R);
      r = -1;
      for (let k = 0; k < R && r < 0; k++) if (s.ready[(pick + k) % R] === 1) r = (pick + k) % R;
      if (r < 0) return end(state, ctx, slot, OUTCOME.rejected, true);
      t.dispatchMs[slot] = now;
      t.replica[slot] = r;
      ctx.notify(TOPIC.requestDispatched, slot, r);
      addLevel(m.outstanding[r]!, now, 1);
      addLevel(m.waiting[r]!, now, 1);
      t.state[slot] = REQUEST_STATE.waiting;
      ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.waiting);
      if (p.fate === OUTCOME.timedOut) ctx.schedule(now + 1500, K_STAGE, slot, STAGE.timeout);
      else ctx.schedule(now + p.waitMs, K_STAGE, slot, STAGE.prefill);
      return;
    }
    case STAGE.prefill:
      addLevel(m.waiting[r]!, now, -1);
      addLevel(m.running[r]!, now, 1);
      s.running[r]! += 1;
      setKv(state, ctx, r);
      t.state[slot] = REQUEST_STATE.prefill;
      ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.prefill);
      ctx.schedule(now + p.ttftMs, K_STAGE, slot, STAGE.first);
      return;
    case STAGE.first: {
      t.firstTokenMs[slot] = now;
      const cached = Math.floor(p.promptTokens * u01(i, 12));
      t.cachedTokens[slot] = cached;
      m.prefillTokens[r]! += p.promptTokens - cached;
      m.prefixQueryTokens[r]! += p.promptTokens;
      m.prefixHitTokens[r]! += cached;
      if (p.turn > 1) {
        m.returningQueryTokens[r]! += p.promptTokens;
        m.returningHitTokens[r]! += cached;
      }
      m.busyMs[r]! += 3 + p.ttftMs * 0.05;
      m.flops[r]! += p.promptTokens * 1.6e10;
      ctx.notify(TOPIC.firstToken, slot, r);
      t.state[slot] = REQUEST_STATE.decode;
      ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.decode);
      const failAt = now + Math.floor((p.outputs - 1) * p.tpotMs * 0.5);
      if (p.fate === OUTCOME.failed) ctx.schedule(failAt, K_STAGE, slot, STAGE.fail);
      else ctx.schedule(now + (p.outputs - 1) * p.tpotMs, K_STAGE, slot, STAGE.end);
      return;
    }
    case STAGE.end:
    case STAGE.fail: {
      const done = st === STAGE.end ? p.outputs : Math.max(1, Math.floor(p.outputs / 2));
      t.outputDone[slot] = done;
      m.decodeTokens[r]! += done;
      m.busyMs[r]! += done * 0.4;
      m.evictedBlocks[r]! += Math.floor(u01(i, 13) * 3);
      if (u01(i, 14) < 0.05) {
        m.preemptions[r]! += 1;
        m.recomputedPrefillTokens[r]! += 100;
        t.preemptions[slot] = 1;
      }
      addLevel(m.running[r]!, now, -1);
      addLevel(m.outstanding[r]!, now, -1);
      s.running[r]! -= 1;
      setKv(state, ctx, r);
      return end(state, ctx, slot, st === STAGE.end ? OUTCOME.finished : OUTCOME.failed, true);
    }
    case STAGE.timeout:
      addLevel(m.waiting[r]!, now, -1);
      addLevel(m.outstanding[r]!, now, -1);
      if (p.attempt > 0) state.shared.meters.fleet.abandonedSessions += 1;
      return end(state, ctx, slot, OUTCOME.timedOut, false);
  }
}

export function synthStub(o: SynthOptions): EngineModule {
  const module = {
    name: SYNTH_STUB,
    init(_state: DayState, ctx: Ctx): SynthSlice {
      const R = ctx.input.config.replicas;
      ctx.schedule(ctx.dayStartMs + o.fromMs, K_ARRIVE, 0);
      if (o.crash) {
        for (const [dt, st] of CRASH_STEPS) {
          ctx.schedule(ctx.dayStartMs + o.crash.atMs + dt, K_CRASH, o.crash.replica, st);
        }
      }
      return { ready: new Uint8Array(R).fill(1), running: new Float64Array(R), rejectSlot: -1 };
    },
    events: [
      {
        kind: K_ARRIVE,
        name: 'e9synth.arrive',
        priority: PRIORITY.arrival,
        handle: (state: DayState, ev: { a: number }, ctx: Ctx) => arrive(state, ev.a, ctx, o),
      },
      {
        kind: K_STAGE,
        name: 'e9synth.stage',
        priority: PRIORITY.engine,
        handle: (state: DayState, ev: { a: number; b: number }, ctx: Ctx) =>
          stage(state, ev.a, ev.b, ctx),
      },
      {
        kind: K_CRASH,
        name: 'e9synth.replica',
        priority: PRIORITY.infra,
        handle(state: DayState, ev: { a: number; b: number }, ctx: Ctx) {
          slice(state).ready[ev.a] = ev.b === REPLICA_STATE.ready ? 1 : 0;
          ctx.notify(TOPIC.replicaState, ev.a, ev.b);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.requestArrived,
        handle(state: DayState, n: { a: number }, ctx: Ctx) {
          const s = slice(state);
          if (s.rejectSlot !== n.a) return;
          s.rejectSlot = -1;
          end(state, ctx, n.a, OUTCOME.rejected, false);
        },
      },
    ],
  };
  return module as unknown as EngineModule;
}
