// Patch handling for one independent day (K21; api.ts Patch). See README "Patches".

import type { DayRunInput, Patch, TunableParams } from '../api.ts';
import { DAY_MS, dayStartMs, type DayIndex } from '../time.ts';
import { canonicalJson } from './plain.ts';

export interface DayPatches {
  /** 'set' patches dated before the day: applied into params before module init. */
  preDay: Patch[];
  /** Patches dated within the day, applied as the first thing at their atMs. */
  inDay: Patch[];
}

/**
 * Sorts by atMs, keeping input order for equal times, and splits for `day`. 'set' patches dated in
 * later days and 'event' patches outside the day are dropped. Returns copies, safe to keep in state.
 */
export function partitionPatches(patches: readonly Patch[], day: DayIndex): DayPatches {
  const start = dayStartMs(day);
  const end = start + DAY_MS;
  for (const p of patches) {
    if (!Number.isFinite(p.atMs)) throw new RangeError(`Patch atMs ${p.atMs} is not finite`);
  }
  // Array.prototype.sort is stable, so equal times keep input order.
  const sorted = [...patches].sort((x, y) => x.atMs - y.atMs);
  const preDay: Patch[] = [];
  const inDay: Patch[] = [];
  for (const p of sorted) {
    if (p.atMs >= start && p.atMs < end) inDay.push(p);
    else if (p.kind === 'set' && p.atMs < start) preDay.push(p);
  }
  return { preDay: copyPatches(preDay), inDay: copyPatches(inDay) };
}

function copyPatches(patches: Patch[]): Patch[] {
  return patches.map((p) =>
    p.kind === 'set'
      ? { kind: 'set', atMs: p.atMs, changes: { ...p.changes } }
      : { kind: 'event', atMs: p.atMs, event: { ...p.event } },
  );
}

/**
 * The tunable parameters in effect at the start of input.day: config.tunable plus the 'set'
 * patches dated before the day, in order. What module init sees in state.core.params; E6's
 * sessionPlan can use it without running the day.
 */
export function dayStartParams(input: DayRunInput): TunableParams {
  const params = { ...input.config.tunable };
  for (const p of partitionPatches(input.patches, input.day).preDay) {
    if (p.kind === 'set') applySetChanges(params, p.changes);
  }
  return params;
}

/** Writes defined values of `changes` into `params`. Unknown keys throw (they are typos). */
export function applySetChanges(params: TunableParams, changes: Partial<TunableParams>): void {
  const target = params as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in target)) throw new Error(`Patch sets unknown tunable parameter '${key}'`);
    if (value !== undefined) target[key] = value;
  }
}

export function samePatchList(a: readonly Patch[], b: readonly Patch[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonicalJson(a[i]) !== canonicalJson(b[i])) return false;
  }
  return true;
}
