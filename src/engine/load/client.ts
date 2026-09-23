// The client side of a session (02 §8, K8): sending turns, the timeout to first token, retries with
// backoff, abandonment, and the coherence rule for the next turn.
//
// Requests are created only from event handlers (sendRequest), never from a notice handler, so the
// shared table never reuses a slot before every requestEnded subscriber has read it. A retry or a
// next turn is therefore always an event, even with zero delay.

import { NO_EVENT, TOPIC, type Ctx, type DayState } from '../core/index.ts';
import { REQUEST_STATE, OUTCOME } from '../results.ts';
import { REQUEST_KIND, allocRequest } from '../shared/index.ts';
import { LOAD_KIND, LOAD_TOPIC, SESSION_END, type SessionEnd } from './ids.ts';
import {
  drawMessageTokens,
  drawOutputTokens,
  drawThinkMs,
  fitMessage,
  fitOutput,
  retriesAllowed,
  retryDelayMs,
} from './script.ts';
import { closeSession, growInt32, type SessionRecord } from './sessions.ts';

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`load: ${msg}`);
}

/**
 * Sets the record's current turn to `turn`, drawing its message and output and fitting them to
 * maxModelLen. Returns false, changing nothing, when the conversation has no room left.
 */
export function prepareTurn(state: DayState, ctx: Ctx, rec: SessionRecord, turn: number): boolean {
  const S = state.load.sessions;
  const cfg = ctx.input.config;
  const maxLen = ctx.input.calibration.engine.maxModelLen;
  const seed = cfg.seed;
  const day = ctx.input.day;
  const id = S.id[rec]!;
  const sys = S.systemPrompt[rec]!;
  const history = S.history[rec]!;
  const scripted = drawMessageTokens(
    seed,
    day,
    id,
    turn,
    S.messageMedian[rec]!,
    cfg.messageTokensSigma,
  );
  const message = fitMessage(maxLen, sys, history, scripted);
  if (message === 0) return false;
  const out = drawOutputTokens(
    seed,
    day,
    id,
    turn,
    S.outputMedian[rec]!,
    cfg.outputTokensSigma,
    cfg.outputTokensMax,
  );
  S.turn[rec] = turn;
  S.attempt[rec] = 0;
  S.message[rec] = message;
  S.output[rec] = fitOutput(maxLen, sys + history + message, out);
  return true;
}

/**
 * Creates the record's current request (turn and attempt) at ctx.nowMs, arms its timeout, and
 * announces it. Call only from an event handler. Nothing may touch the record after the notices:
 * a router may end the request synchronously (a reject), and the retry logic then takes over.
 */
export function sendRequest(state: DayState, ctx: Ctx, rec: SessionRecord): void {
  const L = state.load;
  const S = L.sessions;
  const t = state.shared.requests;
  const slot = allocRequest(t);
  if (t.capacity > L.recOfSlot.length) L.recOfSlot = growInt32(L.recOfSlot, t.capacity, -1);
  t.session[slot] = S.id[rec]!;
  t.analyst[slot] = S.analyst[rec]!;
  t.turn[slot] = S.turn[rec]!;
  t.attempt[slot] = S.attempt[rec]!;
  t.kind[slot] = S.kind[rec]!;
  t.arriveMs[slot] = ctx.nowMs;
  t.promptTokens[slot] = S.systemPrompt[rec]! + S.history[rec]! + S.message[rec]!;
  t.systemPromptTokens[slot] = S.systemPrompt[rec]!;
  t.outputTarget[slot] = S.output[rec]!;
  t.prevReplica[slot] = S.prevReplica[rec]!;
  S.slot[rec] = slot;
  S.ev[rec] = NO_EVENT;
  L.recOfSlot[slot] = rec;
  const timeoutMs = state.core.params.timeoutToFirstTokenMs;
  S.timeoutEv[rec] =
    timeoutMs === null
      ? NO_EVENT
      : ctx.schedule(ctx.nowMs + Math.max(0, timeoutMs), LOAD_KIND.timeout, slot, t.id[slot]!);
  if (S.attempt[rec]! > 0) L.stats.retries++;
  else if (S.kind[rec] === REQUEST_KIND.extra) L.stats.extras++;
  else L.stats.turns++;
  ctx.notify(TOPIC.requestState, slot, REQUEST_STATE.atRouter);
  ctx.notify(TOPIC.requestArrived, slot);
}

/** The record whose request is in `slot`; throws if the slot isn't one of this module's live requests. */
function recordOf(state: DayState, slot: number): SessionRecord {
  const L = state.load;
  const rec = slot >= 0 && slot < L.recOfSlot.length ? L.recOfSlot[slot]! : -1;
  check(rec >= 0 && L.sessions.slot[rec] === slot, `request slot ${slot} is not in flight`);
  return rec;
}

function disarmTimeout(state: DayState, ctx: Ctx, rec: SessionRecord): void {
  const S = state.load.sessions;
  ctx.cancel(S.timeoutEv[rec]!);
  S.timeoutEv[rec] = NO_EVENT;
}

/** A first token arrived: the client stops waiting (K8). Repeat first tokens are harmless. */
export function onFirstToken(state: DayState, slot: number, ctx: Ctx): void {
  disarmTimeout(state, ctx, recordOf(state, slot));
}

/** The timeout fired before a first token: tell the holder to cancel; it ends the request. */
export function onTimeout(state: DayState, slot: number, requestId: number, ctx: Ctx): void {
  const rec = recordOf(state, slot);
  const S = state.load.sessions;
  check(state.shared.requests.id[slot] === requestId, `timeout for a reused slot ${slot}`);
  S.timeoutEv[rec] = NO_EVENT;
  ctx.notify(TOPIC.requestCancelled, slot);
}

function endSession(state: DayState, ctx: Ctx, rec: SessionRecord, how: SessionEnd): void {
  const L = state.load;
  const S = L.sessions;
  const organic = S.kind[rec] === REQUEST_KIND.turn;
  const id = S.id[rec]!;
  if (how === SESSION_END.abandoned) {
    L.stats.abandoned++;
    if (organic) state.shared.meters.fleet.abandonedSessions++;
  } else if (how === SESSION_END.completed) {
    L.stats.completed++;
  } else {
    L.stats.cutOff++;
  }
  closeSession(S, rec);
  if (organic) ctx.notify(LOAD_TOPIC.sessionEnded, id, how);
}

/** Schedules the record's pending arrival; ends the session if it would fall after the day. */
function schedulePending(
  state: DayState,
  ctx: Ctx,
  rec: SessionRecord,
  atMs: number,
  kind: number,
): void {
  const S = state.load.sessions;
  const ev = ctx.schedule(atMs, kind, rec, S.id[rec]!);
  if (ev === NO_EVENT) endSession(state, ctx, rec, SESSION_END.cutOff);
  else S.ev[rec] = ev;
}

/**
 * A request of this module ended (the shared module has already queued its slot for reuse, but its
 * fields are still readable). Finished: extend history and schedule the next turn. Otherwise retry
 * if attempts remain, else the analyst abandons the session.
 */
export function onRequestEnded(state: DayState, slot: number, outcome: number, ctx: Ctx): void {
  const rec = recordOf(state, slot);
  const L = state.load;
  const S = L.sessions;
  const t = state.shared.requests;
  disarmTimeout(state, ctx, rec);
  S.slot[rec] = -1;
  L.recOfSlot[slot] = -1;

  if (outcome !== OUTCOME.finished) {
    const p = state.core.params;
    const attempt = S.attempt[rec]!;
    if (attempt >= retriesAllowed(p.retryPolicy, p.maxRetries)) {
      endSession(state, ctx, rec, SESSION_END.abandoned);
      return;
    }
    const delay = retryDelayMs(
      p.retryPolicy,
      p.retryBaseMs,
      p.retryCapMs,
      ctx.input.config.seed,
      ctx.input.day,
      S.id[rec]!,
      S.turn[rec]!,
      attempt,
    );
    S.attempt[rec] = attempt + 1;
    schedulePending(state, ctx, rec, ctx.nowMs + delay, LOAD_KIND.retry);
    return;
  }

  // Finished: the turn enters history (K8), and its replica becomes the session's previous one.
  S.history[rec] = S.history[rec]! + S.message[rec]! + t.outputTarget[slot]!;
  S.prevReplica[rec] = t.replica[slot]!;
  const turn = S.turn[rec]!;
  if (turn >= S.turns[rec]!) {
    endSession(state, ctx, rec, SESSION_END.completed);
    return;
  }
  // Coherence rule (02 §8): the next turn goes at this turn's arrival plus think time, or at once
  // if this turn ran longer than that. A next turn at or after the shift's end never goes (K23).
  const cfg = ctx.input.config;
  const think = drawThinkMs(
    cfg.seed,
    ctx.input.day,
    S.id[rec]!,
    turn,
    S.thinkMedianMs[rec]!,
    cfg.thinkTimeShape,
  );
  const nextMs = Math.max(t.arriveMs[slot]! + think, ctx.nowMs);
  if (!(nextMs < ctx.dayStartMs + cfg.shift.endMs) || !prepareTurn(state, ctx, rec, turn + 1)) {
    endSession(state, ctx, rec, SESSION_END.completed);
    return;
  }
  schedulePending(state, ctx, rec, nextMs, LOAD_KIND.nextTurn);
}
