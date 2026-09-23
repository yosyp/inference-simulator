// Load generator and client (WP E6; 02 §8; K6, K8, K21, K23). Module order for E11: shared, load,
// router, replica, failure, metrics. E11: `{ ...createDayRunner(modules), sessionPlan }`.
//
// Session starts (arrivals.ts). Open loop, per day. The intensity is the diurnal knots cut to the
// shift × dayMultipliers[day] × params.loadMultiplier × active loadSpike multipliers, scaled so a
// day at multiplier 1 expects analystsPerReplica × replicas × sessionsPerAnalystPerDay ×
// dayMultiplier sessions. Candidates come one event at a time from a bounded-rate Poisson process
// keyed by (day, candidate), thinned by a keyed uniform, so a mid-day loadMultiplier change adds or
// removes sessions without moving the others. The product of multipliers is clamped to
// MAX_LOAD_MULTIPLIER (4). A session's id is its candidate index (sparse, day-local); its analyst is
// a keyed uniform draw over all analysts.
//
// Scripts (script.ts). Keyed on (day, session, turn), with the workload parameters in effect at the
// session's start (turn mean, medians, and the system prompt, which stays fixed for the session so
// its KV blocks keep their identity): geometric turns, lognormal message and output lengths (output
// capped at outputTokensMax), log-logistic think time.
//
// Turns (client.ts). Turn N+1 arrives at max(turn N's arrival + think time, turn N's finish): the
// coherence rule. Its prompt is the system prompt + the session's successful turns' messages and
// outputs + the new message; failed turns never enter history (K8). Bounds:
// - A next turn at or after the shift's end is never sent; the session completes there (K23).
// - prompt + output stays within calibration maxModelLen: the message is cut to fit with one output
//   token, the output target to the room left, and a session whose history leaves no room completes.
// - Turns per session are capped at 65,535 and retries at 255 (the request table's field widths).
//
// Client (client.ts, K8). The timeout to first token (params at arrival) is armed at arrival and
// disarmed by firstToken; when it fires, requestCancelled goes out and the holder ends the request.
// On requestEnded: finished extends history and schedules the next turn; anything else retries after
// the policy's backoff if attempts remain (params at the failure), else the analyst abandons the
// session (meters.fleet.abandonedSessions). Backoff after attempt a (0-based): immediate 0; fixed
// base; exponential min(cap, base × 2^a); fullJitter uniform(0, min(cap, base × 2^a)) keyed on
// (day, session, turn, a). Retries, next turns, and extra requests are events in the arrival band;
// timeouts are in the client band.
//
// Injected events. extraRequest: one single-turn request of kind extra, whose promptTokens is the
// whole prompt (the current system prompt's shared blocks included) and whose synthetic session id
// is EXTRA_SESSION_BASE + n. 'tracked' resolves to input.trackedAnalyst, or to a keyed analyst when
// none is tracked. Extra requests time out and retry like any other; they never count as sessions.
// loadSpike: multiplies the intensity over [atMs, atMs + durationMs).
//
// Topics. Listens to firstToken and requestEnded (a = request slot). Emits requestState (atRouter)
// and requestArrived for each new request, requestCancelled on a timeout, and
// LOAD_TOPIC.sessionEnded (a = session, b = SESSION_END) when an organic session ends.

export {
  MAX_LOAD_MULTIPLIER,
  buildEnvelope,
  type ArrivalEnvelope,
  type CandidateCursor,
} from './arrivals.ts';
export {
  EXTRA_SESSION_BASE,
  LOAD_KIND,
  LOAD_PRIORITY,
  LOAD_TOPIC,
  SESSION_END,
  type SessionEnd,
} from './ids.ts';
export { loadModule, type LoadSlice, type LoadStats } from './module.ts';
export { sessionPlan } from './plan.ts';
export { MAX_RETRIES, MAX_TURNS, retryDelayMs } from './script.ts';
export type { SessionTable } from './sessions.ts';
