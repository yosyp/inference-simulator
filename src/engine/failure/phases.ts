// Replica lifecycle phases (02 §9): the legal transitions and their durations. Pure helpers, shared
// by the failure module, tests, and the UI, which can rebuild loading progress from a chunk's
// replica events with phaseTiming and phaseDurationMs.

import type { SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { REPLICA_STATE, type ReplicaState } from '../results.ts';

const S = REPLICA_STATE;

/**
 * Time from mark-down to the replacement host's process start, when weight loading begins. 0: the
 * enclave keeps a standby host, and the R7 replacement-host clock starts at process start, so there
 * is no measured provisioning time to add. With 0, Down is an instant: mark-down and load start
 * happen at the same time, in that order.
 */
export const REPLACEMENT_START_MS = 0;

/**
 * Every transition the state machine may take (from → to). A crash is the only way out of Ready.
 * Recovery runs Crashed → Down → loadingWeights → initializingEngine → Ready. A crash during
 * Down, loadingWeights, or initializingEngine restarts recovery from Crashed. A crash during
 * Crashed is ignored, so there is no Crashed → Crashed edge.
 */
export const LEGAL_TRANSITIONS: readonly (readonly [ReplicaState, ReplicaState])[] = [
  [S.ready, S.crashed],
  [S.crashed, S.down],
  [S.down, S.loadingWeights],
  [S.loadingWeights, S.initializingEngine],
  [S.initializingEngine, S.ready],
  [S.down, S.crashed],
  [S.loadingWeights, S.crashed],
  [S.initializingEngine, S.crashed],
];

const STATE_COUNT = 5;
const LEGAL = new Uint8Array(STATE_COUNT * STATE_COUNT);
for (const [from, to] of LEGAL_TRANSITIONS) LEGAL[from * STATE_COUNT + to] = 1;

export function isReplicaState(code: number): code is ReplicaState {
  return Number.isInteger(code) && code >= 0 && code < STATE_COUNT;
}

export function isLegalTransition(from: number, to: number): boolean {
  return isReplicaState(from) && isReplicaState(to) && LEGAL[from * STATE_COUNT + to] === 1;
}

/** The recovery constants for one scenario, in ms. Plain data; the failure slice keeps a copy. */
export interface PhaseTiming {
  /** Crashed → Down (config.detectionDelayMs). */
  detectionDelayMs: number;
  /** Down → loadingWeights (REPLACEMENT_START_MS). */
  replacementStartMs: number;
  /** Process start → weights loaded (calibration.coldStartMs[config.coldStart]). */
  weightsLoadedMs: number;
  /** Process start → engine ready; >= weightsLoadedMs. */
  engineReadyMs: number;
}

/** The scenario's recovery constants. Throws on a detection delay that isn't a finite ms >= 0. */
export function phaseTiming(config: SimConfig, calibration: Calibration): PhaseTiming {
  const detectionDelayMs = config.detectionDelayMs;
  if (!(Number.isFinite(detectionDelayMs) && detectionDelayMs >= 0)) {
    throw new RangeError(
      `failure: detectionDelayMs ${detectionDelayMs} should be a finite ms >= 0`,
    );
  }
  const cold = calibration.coldStartMs?.[config.coldStart];
  if (cold === undefined) {
    throw new Error(`failure: the calibration has no coldStartMs.${config.coldStart}`);
  }
  const { weightsLoaded, engineReady } = cold;
  if (!(Number.isFinite(weightsLoaded) && weightsLoaded >= 0 && engineReady >= weightsLoaded)) {
    throw new RangeError(`failure: coldStartMs.${config.coldStart} is not a valid phase pair`);
  }
  return {
    detectionDelayMs,
    replacementStartMs: REPLACEMENT_START_MS,
    weightsLoadedMs: weightsLoaded,
    engineReadyMs: engineReady,
  };
}

/** How long a replica stays in `code` once it enters it; Infinity for Ready. */
export function phaseDurationMs(timing: PhaseTiming, code: ReplicaState): number {
  switch (code) {
    case S.ready:
      return Infinity;
    case S.crashed:
      return timing.detectionDelayMs;
    case S.down:
      return timing.replacementStartMs;
    case S.loadingWeights:
      return timing.weightsLoadedMs;
    case S.initializingEngine:
      return timing.engineReadyMs - timing.weightsLoadedMs;
  }
}
