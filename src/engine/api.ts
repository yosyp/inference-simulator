// Engine contract (docs/00-build.md §4). Frozen at M0: change only through the integrator.
// The engine is pure and deterministic; it runs one independent day at a time (02 §8, K21).

import type { Calibration, ColdStartCondition } from './calibration.ts';
import type { ResultChunk } from './results.ts';
import type { DayIndex, SimMs } from './time.ts';

export type ReplicaId = number;
export type AnalystId = number;
/** Day-local session id. */
export type SessionId = number;
/** Day-local request id. Each retry attempt is a new request (02 §3). */
export type RequestId = number;

export type RoutingPolicy =
  'roundRobin' | 'leastOutstanding' | 'sessionAffinity' | 'kvUtilization' | 'weighted';
export type HashScheme = 'modN' | 'consistent';
export type RetryPolicy = 'none' | 'immediate' | 'fixed' | 'exponential' | 'fullJitter';

/**
 * Parameters a scenario's drawer or trigger may change mid-week through a 'set' patch.
 * Workload fields apply to sessions that start at or after the patch time; router and client
 * fields apply to requests dispatched or retried after it.
 */
export interface TunableParams {
  /** Scales the session-start rate. E6: thin a bounded-rate process with keyed uniforms so a change adds or removes sessions without moving others. */
  loadMultiplier: number;
  systemPromptTokens: number;
  /** Geometric mean, >= 1. A mean of 1 gives single-turn sessions (01 §5 step c1). */
  turnsPerSessionMean: number;
  messageTokensMedian: number;
  outputTokensMedian: number;
  thinkTimeMedianMs: number;
  /** Client gives up if no token has arrived by then (K8). null means no timeout. */
  timeoutToFirstTokenMs: number | null;
  retryPolicy: RetryPolicy;
  retryBaseMs: number;
  retryCapMs: number;
  maxRetries: number;
  routingPolicy: RoutingPolicy;
  hashScheme: HashScheme;
  /** Load signals the router sees are refreshed at this interval (02 §7). */
  signalRefreshMs: number;
  /**
   * Fleet cap = this × routable replicas (Ready, plus crashed-but-not-yet-marked-down), on requests the
   * router has admitted and not seen end, including those still in the router overhead (K9). null
   * disables admission control.
   */
  admissionLimitPerReplica: number | null;
  weightAffinity: number;
  weightOutstanding: number;
  weightKv: number;
}

/** Fixed per scenario, plus the tunable parameters' starting values. */
export interface SimConfig {
  /** uint32. */
  seed: number;
  replicas: number;
  analystsPerReplica: number;
  /** Analyst shift as time of day in ms; playback skips outside it (05 §5). */
  shift: { startMs: number; endMs: number };
  /**
   * Session-start intensity over the day: piecewise-linear knots of [time of day ms, relative weight],
   * zero outside the first and last knot, scaled per day by dayMultipliers.
   */
  diurnal: {
    knots: readonly (readonly [number, number])[];
    dayMultipliers: readonly [number, number, number, number, number];
  };
  /** Expected sessions per analyst on a day with multiplier 1. */
  sessionsPerAnalystPerDay: number;
  messageTokensSigma: number;
  outputTokensSigma: number;
  outputTokensMax: number;
  /** Log-logistic think-time shape β (the median is tunable): the mean is finite for β > 1, the variance for β > 2. */
  thinkTimeShape: number;
  virtualNodesPerReplica: number;
  routerOverheadMs: number;
  detectionDelayMs: number;
  coldStart: ColdStartCondition;
  engineOverrides: { maxNumSeqs?: number; maxNumBatchedTokens?: number };
  /** Scalar metric bucket width. Must divide histBucketMs. S1 tunes both. */
  bucketMs: number;
  /** Histogram bucket width. Checkpoints and fork cuts align to it. Must divide DAY_MS. */
  histBucketMs: number;
  tunable: TunableParams;
}

export type InjectedEvent =
  | { type: 'crash'; replica: ReplicaId }
  /** An extra single-turn request, e.g. tab 1's long prompt. 'tracked' resolves to the tracked analyst. */
  | {
      type: 'extraRequest';
      analyst: AnalystId | 'tracked';
      promptTokens: number;
      outputTokens: number;
    }
  | { type: 'loadSpike'; multiplier: number; durationMs: number };

/**
 * A change at time atMs (K21). 'set' is lasting: it also applies to later days, from their start.
 * 'event' is one-shot: it applies only on its own day.
 */
export type Patch =
  | { kind: 'set'; atMs: SimMs; changes: Partial<TunableParams> }
  | { kind: 'event'; atMs: SimMs; event: InjectedEvent };

/** A patch without its time; the UI fills atMs with the playhead when a trigger fires. */
export type PatchTemplate =
  { kind: 'set'; changes: Partial<TunableParams> } | { kind: 'event'; event: InjectedEvent };

export function patchAt(template: PatchTemplate, atMs: SimMs): Patch {
  return template.kind === 'set'
    ? { kind: 'set', atMs, changes: template.changes }
    : { kind: 'event', atMs, event: template.event };
}

export function isLasting(patch: Patch): boolean {
  return patch.kind === 'set';
}

export interface DayRunInput {
  config: SimConfig;
  calibration: Calibration;
  day: DayIndex;
  /**
   * Every patch in effect for the week. 'set' patches apply in atMs order, and patches with equal
   * atMs apply in array order, so a later fork at the same instant wins (the drawer relies on this).
   * The engine applies 'set' patches dated before this day from the day's start, and 'event' patches
   * only if they fall within this day.
   */
  patches: readonly Patch[];
  trackedAnalyst: AnalystId | null;
  /** Record every request's records and transitions, not only the tracked analyst's (see ResultChunk). */
  detail: 'all' | 'tracked';
}

/** Checkpoint of a day run. `state` is plain data, safe for structuredClone and postMessage. */
export interface DayCheckpoint {
  readonly day: DayIndex;
  readonly atMs: SimMs;
  readonly state: unknown;
}

export interface DayRun {
  readonly day: DayIndex;
  /** Simulated time reached so far. */
  readonly nowMs: SimMs;
  /** True once the day has been simulated to its end. */
  readonly done: boolean;
  /**
   * Simulate to min(untilMs, end of day) and return what was produced since the previous call.
   * Buckets are emitted only once complete; the rest carries in state.
   */
  advance(untilMs: SimMs): ResultChunk;
  checkpoint(): DayCheckpoint;
}

/** A session as planned from its keyed script (K6), before simulation; used to pick the tracked analyst. */
export interface SessionSummary {
  session: SessionId;
  analyst: AnalystId;
  startMs: SimMs;
  turns: number;
  /** Start plus scripted think times; actual turns may run later under load. */
  plannedEndMs: SimMs;
}

export interface Engine {
  createDayRun(input: DayRunInput): DayRun;
  /** Resume from a checkpoint. Patches dated at or after the checkpoint may differ from the original run. */
  restoreDayRun(input: DayRunInput, checkpoint: DayCheckpoint): DayRun;
  sessionPlan(input: DayRunInput): SessionSummary[];
}
