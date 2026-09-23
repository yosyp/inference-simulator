// workloadShift (InjectedEvent): one-shot workload values for sessions that start in a window.
// Shared by the module and sessionPlan, so both freeze the same values at a session's start.

import type { InjectedEvent, TunableParams } from '../api.ts';

type WorkloadShiftEvent = Extract<InjectedEvent, { type: 'workloadShift' }>;
type WorkloadChanges = WorkloadShiftEvent['changes'];

const SHIFTABLE: ReadonlySet<string> = new Set([
  'turnsPerSessionMean',
  'messageTokensMedian',
  'outputTokensMedian',
  'thinkTimeMedianMs',
] satisfies (keyof WorkloadChanges)[]);

/** A shift injected today: it covers session starts before endMs. Plain data (checkpoints). */
export interface WorkloadShift {
  endMs: number;
  changes: WorkloadChanges;
}

/** Validates the event and returns the shift injected at atMs, with its own copy of the changes. */
export function workloadShiftAt(event: WorkloadShiftEvent, atMs: number): WorkloadShift {
  if (!(event.durationMs > 0)) {
    throw new RangeError(`workloadShift needs a positive duration, got ${event.durationMs}`);
  }
  const changes: Record<string, number> = {};
  for (const [key, value] of Object.entries(event.changes)) {
    if (!SHIFTABLE.has(key)) throw new RangeError(`workloadShift can't change '${key}'`);
    if (value !== undefined) changes[key] = value;
  }
  return { endMs: atMs + event.durationMs, changes };
}

/**
 * The params a session starting at nowMs uses: `params` with each shift still covering nowMs
 * applied in patch order. Returns `params` itself when no shift covers nowMs.
 */
export function shiftedParams(
  params: TunableParams,
  shifts: readonly WorkloadShift[],
  nowMs: number,
): TunableParams {
  let out = params;
  for (const s of shifts) {
    if (!(nowMs < s.endMs)) continue;
    if (out === params) out = { ...params };
    Object.assign(out, s.changes);
  }
  return out;
}
