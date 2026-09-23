// Event kinds, topics, and codes of the load generator and client (KIND_RANGES.load: 100-199).

import { PRIORITY } from '../core/index.ts';

export const LOAD_KIND = {
  /** A candidate session start (a = candidate index). */
  candidate: 100,
  /** The next turn of a session (a = session record, b = session id). */
  nextTurn: 101,
  /** A retry of the session's current turn (a = session record, b = session id). */
  retry: 102,
  /** An injected extra request (a = session record, b = synthetic session id). */
  extra: 103,
  /** A loadSpike ends (a = spike index). */
  spikeEnd: 104,
  /** Client timeout to first token (a = request slot, b = request id). */
  timeout: 105,
} as const;

/**
 * At one instant a spike's end runs before candidates, so a spike covers [atMs, atMs + durationMs).
 * Everything else that sends a request shares one arrival priority; push order breaks ties.
 */
export const LOAD_PRIORITY = {
  spikeEnd: PRIORITY.arrival,
  send: PRIORITY.arrival + 1,
  timeout: PRIORITY.client,
} as const;

export const LOAD_TOPIC = {
  /**
   * A session ended and will send nothing more. a = SessionId, b = SESSION_END code. Emitted for
   * organic sessions only (not extra requests), after the last request of the session ended.
   */
  sessionEnded: 100,
} as const;

export const SESSION_END = {
  /** Every scripted turn ran, or the session stopped at the shift's end or a full context. */
  completed: 1,
  /** A turn ran out of retries (K8); counted in meters.fleet.abandonedSessions. */
  abandoned: 2,
  /** A retry would have fallen after the day's end. */
  cutOff: 3,
} as const;
export type SessionEnd = (typeof SESSION_END)[keyof typeof SESSION_END];

/**
 * Synthetic session ids for extra requests start here: EXTRA_SESSION_BASE + n for the day's n-th
 * extra request. Organic session ids are candidate indices, far below it, so an extra request's KV
 * blocks never match a real session's.
 */
export const EXTRA_SESSION_BASE = 0x8000_0000;
