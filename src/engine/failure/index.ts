// Failure and recovery (WP E8; 02 §9; 01 §5 concepts 9–11). `failureModule` plugs into the day
// runner after the replica module (E5) and before metrics (E9). It owns each replica's lifecycle
// state and emits TOPIC.replicaState (a = replica, b = REPLICA_STATE) at every change, never at
// init: each day starts with every replica Ready (K21), and nothing carries to the next day.
//
// A crash comes from an injected event, { type: 'crash', replica } (a baseline 'event' patch or a
// fork's trigger), applied at the patch's instant, before any event there (K27). For a crash at t
// with the scenario's config.detectionDelayMs = d and calibration.coldStartMs[config.coldStart] =
// { weightsLoaded: w, engineReady: e }:
//
//   t          crashed             The router still routes to it: it can't see the crash yet. E5
//                                  fails everything in flight, wipes the KV pool, and fails each
//                                  new dispatch at once, so clients retry (tab 6). Failing fast
//                                  keeps its outstanding count at 0, so least-outstanding sends it
//                                  most traffic until mark-down (a black hole).
//   t+d        down                Marked down; the router stops routing to it.
//   t+d+g      loadingWeights      Replacement process start (g = REPLACEMENT_START_MS = 0).
//   t+d+g+w    initializingEngine
//   t+d+g+e    ready               Rejoins with an empty KV cache (E5); under least-outstanding it
//                                  draws a flood of cold traffic (concept 11).
//
// Events at one instant keep this order, so with g = 0 Down lasts no time: down, then
// loadingWeights, both at t+d. The phase events use PRIORITY.infra, so they precede engine events
// at the same instant. Ready lands exactly e after load start, as R7 measures it.
//
// Choices:
// - The gap from mark-down to load start is 0 (REPLACEMENT_START_MS): the enclave keeps a standby
//   host and R7's replacement-host clock starts at process start; no provisioning time is measured.
// - A crash of a Crashed replica (not yet marked down) is ignored: it is already dead, and
//   detection is under way. A crash of a replica in Down, loadingWeights, or initializingEngine
//   restarts recovery: crashed now, then the whole timeline again from this crash. The router
//   already has it marked down, and Crashed doesn't make it routable, so it stays out of the
//   routing set throughout. A crash patch at the same instant as a phase event wins (patches go
//   first), so a crash at the exact Ready time restarts recovery rather than following Ready.
// - Crashes of different replicas are independent, at the same instant or not; each has its own
//   timeline. Several crash patches at one instant apply in patch order.
// - A phase that ends at or after the day's end gets no event (schedule returns NO_EVENT): the
//   replica stays in that phase until the day ends. A crash too late for detection leaves the
//   replica Crashed, and routed to, for the rest of the day.
// - A crash of a replica index outside the fleet throws: the scenario is wrong.
//
// Legal transitions (LEGAL_TRANSITIONS; `enter` throws on any other): ready → crashed → down →
// loadingWeights → initializingEngine → ready, plus down, loadingWeights, and initializingEngine →
// crashed (restart). Invariants: every non-Ready replica has exactly one pending phase event (none
// if its phase outlasts the day), and its phase times follow from the crash and load start.
//
// Reading the phase:
//   replicaPhase(state, r) → { state, startMs, endMs }    // endMs may lie past the day; Infinity if Ready
//   phaseTiming(config, calibration), phaseDurationMs(timing, code)  // the same numbers, without state
//
// No randomness: a crash is scripted, so Source.failure (rng/sources.ts) stays unused for now.

export {
  EV_ENGINE_READY,
  EV_LOAD_START,
  EV_MARK_DOWN,
  EV_WEIGHTS_LOADED,
  PHASE_END_KIND,
  failureModule,
} from './module.ts';
export {
  LEGAL_TRANSITIONS,
  REPLACEMENT_START_MS,
  isLegalTransition,
  isReplicaState,
  phaseDurationMs,
  phaseTiming,
  type PhaseTiming,
} from './phases.ts';
export { replicaPhase, type FailureSlice, type FailureStats, type ReplicaPhase } from './slice.ts';
export { assertFailureInvariants } from './invariants.ts';
