// The failure slice: each replica's lifecycle state and the phase it is in (02 §9). Plain data.

import type { DayRunInput, ReplicaId } from '../api.ts';
import type { DayState } from '../core/types.ts';
import { NO_EVENT } from '../core/queue.ts';
import { REPLICA_STATE, type ReplicaState } from '../results.ts';
import type { SimMs } from '../time.ts';
import { phaseTiming, type PhaseTiming } from './phases.ts';

const S = REPLICA_STATE;

export interface FailureStats {
  /** Crashes of a Ready replica. */
  crashes: number;
  /** Crashes during recovery (Down, loadingWeights, initializingEngine), which restart it. */
  restarts: number;
  /** Crashes of a replica already Crashed and not yet marked down; they change nothing. */
  ignored: number;
}

export interface FailureSlice {
  replicas: number;
  /** Recovery constants for this scenario (phaseTiming). */
  timing: PhaseTiming;
  /** REPLICA_STATE code per replica. Every replica is Ready at the day's start (K21). */
  state: Uint8Array;
  /** When the current phase began (dayStartMs for a replica Ready since the morning). */
  phaseStartMs: Float64Array;
  /** When the current phase ends, even past the day's end; Infinity while Ready. */
  phaseEndMs: Float64Array;
  /** Event that ends the current phase; NO_EVENT while Ready or when it falls past the day's end. */
  phaseEv: Float64Array;
  /** The latest crash that started or restarted recovery; NaN if none today. */
  crashMs: Float64Array;
  /** Process start of the replacement (load start) in the current recovery; NaN before it. */
  loadStartMs: Float64Array;
  stats: FailureStats;
}

declare module '../core/types.ts' {
  interface DayState {
    failure: FailureSlice;
  }
}

/** The standard morning state (K21): every replica Ready since the day's start, nothing pending. */
export function createFailureSlice(input: DayRunInput, dayStartMs: SimMs): FailureSlice {
  const n = input.config.replicas;
  return {
    replicas: n,
    timing: phaseTiming(input.config, input.calibration),
    state: new Uint8Array(n).fill(S.ready),
    phaseStartMs: new Float64Array(n).fill(dayStartMs),
    phaseEndMs: new Float64Array(n).fill(Infinity),
    phaseEv: new Float64Array(n).fill(NO_EVENT),
    crashMs: new Float64Array(n).fill(NaN),
    loadStartMs: new Float64Array(n).fill(NaN),
    stats: { crashes: 0, restarts: 0, ignored: 0 },
  };
}

/**
 * When a phase that replica r entered at startMs ends. The load phases count from load start
 * (process start), as R7 measures them, so Ready lands exactly engineReadyMs after load start.
 */
export function phaseEndFor(
  s: FailureSlice,
  r: ReplicaId,
  code: ReplicaState,
  startMs: SimMs,
): SimMs {
  const t = s.timing;
  switch (code) {
    case S.ready:
      return Infinity;
    case S.crashed:
      return startMs + t.detectionDelayMs;
    case S.down:
      return startMs + t.replacementStartMs;
    case S.loadingWeights:
      return s.loadStartMs[r]! + t.weightsLoadedMs;
    case S.initializingEngine:
      return s.loadStartMs[r]! + t.engineReadyMs;
  }
}

/**
 * Where a replica's current phase stands. endMs is when the phase's event fires (the next
 * transition), even if that falls after the day's end and so never fires; Infinity while Ready.
 * Loading progress is (now - startMs) / (endMs - startMs).
 */
export interface ReplicaPhase {
  state: ReplicaState;
  startMs: SimMs;
  endMs: SimMs;
}

/** The replica's current phase in a day run's state (the failure slice). */
export function replicaPhase(state: DayState, replica: ReplicaId): ReplicaPhase {
  const s = state.failure;
  if (!(Number.isInteger(replica) && replica >= 0 && replica < s.replicas)) {
    throw new RangeError(`replicaPhase: replica ${replica} is out of range`);
  }
  return {
    state: s.state[replica] as ReplicaState,
    startMs: s.phaseStartMs[replica]!,
    endMs: s.phaseEndMs[replica]!,
  };
}
