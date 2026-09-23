// Session scripts and client backoff (02 §8, K6, K8, K23). Every quantity is one keyed draw, so a
// (session, turn) gets the same lengths and think time in every run, whatever the router, the
// client settings, or the order in which the simulation asks for them.
//
// Keys (turn is 1-based, as in the request table; session ids are day-local):
//   turns          Source.turns          (day, session)
//   message        Source.messageLength  (day, session, turn)
//   output         Source.outputLength   (day, session, turn)
//   think after N  Source.thinkTime      (day, session, N)
//   retry jitter   Source.retryJitter    (day, session, turn, attempt that failed)
//
// The medians and the turn mean are the parameters in effect when the session started; the sigmas,
// the output cap, and the think-time shape come from the SimConfig.

import type { RetryPolicy } from '../api.ts';
import { Source, geometric, logLogistic, lognormal, u01, uniform } from '../rng/index.ts';
import type { DayIndex } from '../time.ts';

/** Largest scripted turn count: the request table stores turns as uint16. */
export const MAX_TURNS = 0xffff;
/** Largest retry count honoured: the request table stores attempts as uint8. */
export const MAX_RETRIES = 0xff;

/** Turns in the session: geometric with the given mean, capped at MAX_TURNS. */
export function drawTurns(seed: number, day: DayIndex, session: number, mean: number): number {
  return Math.min(MAX_TURNS, geometric(u01(seed, Source.turns, day, session), mean));
}

/** New-message tokens of a turn: lognormal, rounded, at least 1. */
export function drawMessageTokens(
  seed: number,
  day: DayIndex,
  session: number,
  turn: number,
  median: number,
  sigma: number,
): number {
  const u = u01(seed, Source.messageLength, day, session, turn);
  return Math.max(1, Math.round(lognormal(u, median, sigma)));
}

/** Output tokens of a turn: lognormal, rounded, in [1, max]. */
export function drawOutputTokens(
  seed: number,
  day: DayIndex,
  session: number,
  turn: number,
  median: number,
  sigma: number,
  max: number,
): number {
  const u = u01(seed, Source.outputLength, day, session, turn);
  return Math.min(max, Math.max(1, Math.round(lognormal(u, median, sigma))));
}

/** Think time after turn `turn`, before the next one: log-logistic (K23), in ms. */
export function drawThinkMs(
  seed: number,
  day: DayIndex,
  session: number,
  turn: number,
  median: number,
  shape: number,
): number {
  return logLogistic(u01(seed, Source.thinkTime, day, session, turn), median, shape);
}

/**
 * Retries allowed after a failed attempt: 0 under 'none', else maxRetries clamped to
 * [0, MAX_RETRIES].
 */
export function retriesAllowed(policy: RetryPolicy, maxRetries: number): number {
  if (policy === 'none' || !(maxRetries > 0)) return 0;
  return Math.min(MAX_RETRIES, Math.floor(maxRetries));
}

/**
 * Delay before retrying after attempt `attempt` (0-based) of (session, turn) failed:
 * immediate 0; fixed base; exponential min(cap, base × 2^attempt); fullJitter a keyed
 * uniform(0, min(cap, base × 2^attempt)). So the first retry waits base, the second 2 × base, and
 * so on. Never negative.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  baseMs: number,
  capMs: number,
  seed: number,
  day: DayIndex,
  session: number,
  turn: number,
  attempt: number,
): number {
  switch (policy) {
    case 'none':
    case 'immediate':
      return 0;
    case 'fixed':
      return Math.max(0, baseMs);
    case 'exponential':
      return Math.max(0, Math.min(capMs, baseMs * 2 ** attempt));
    case 'fullJitter': {
      const hi = Math.max(0, Math.min(capMs, baseMs * 2 ** attempt));
      return uniform(u01(seed, Source.retryJitter, day, session, turn, attempt), 0, hi);
    }
  }
}

/**
 * The system prompt a session uses for all its turns: the value in effect at its start, rounded,
 * and short enough to leave room for one message token and one output token.
 */
export function sessionSystemPrompt(systemPromptTokens: number, maxModelLen: number): number {
  return Math.min(Math.max(0, Math.round(systemPromptTokens)), Math.max(0, maxModelLen - 2));
}

/**
 * The new message a turn can send, keeping prompt + 1 output token within maxModelLen: the scripted
 * length, cut to the room left. 0 means the conversation is full and the session ends.
 */
export function fitMessage(
  maxModelLen: number,
  systemPrompt: number,
  history: number,
  scripted: number,
): number {
  const room = maxModelLen - systemPrompt - history - 1;
  return room < 1 ? 0 : Math.min(scripted, room);
}

/** The output target, keeping prompt + output within maxModelLen (at least 1). */
export function fitOutput(maxModelLen: number, promptTokens: number, scripted: number): number {
  return Math.max(1, Math.min(scripted, maxModelLen - promptTokens));
}
