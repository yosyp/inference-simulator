// Time-weighted levels (KV usage, running and waiting counts) without a per-event hook.
//
// A Level integrates lazily: each change adds value × elapsed to `area`, so the cost is per change,
// not per event per module. At a bucket boundary (onBucketEnd), takeLevelMean closes the interval
// and returns the time-weighted mean since the previous take. Plain data; keep Levels in a slice.

import type { SimMs } from '../time.ts';

export interface Level {
  value: number;
  /** Time up to which `area` is integrated. */
  sinceMs: SimMs;
  /** ∫ value dt since the last take, in value × ms. */
  area: number;
  /** Largest value held since the last take. */
  max: number;
  /** Start of the interval the next take averages over. */
  openedMs: SimMs;
}

export function createLevel(atMs: SimMs, value = 0): Level {
  return { value, sinceMs: atMs, area: 0, max: value, openedMs: atMs };
}

/** The level becomes `value` at atMs (atMs must not go backwards). */
export function setLevel(level: Level, atMs: SimMs, value: number): void {
  if (atMs < level.sinceMs) throw new RangeError(`Level set at ${atMs} before ${level.sinceMs}`);
  level.area += level.value * (atMs - level.sinceMs);
  level.sinceMs = atMs;
  level.value = value;
  if (value > level.max) level.max = value;
}

export function addLevel(level: Level, atMs: SimMs, delta: number): void {
  setLevel(level, atMs, level.value + delta);
}

/**
 * Time-weighted mean over [openedMs, atMs), then starts a new interval at atMs. Read `max` first if
 * you need it; the take resets it to the current value. Returns the current value for an empty
 * interval.
 */
export function takeLevelMean(level: Level, atMs: SimMs): number {
  setLevel(level, atMs, level.value);
  const span = atMs - level.openedMs;
  const mean = span > 0 ? level.area / span : level.value;
  level.area = 0;
  level.max = level.value;
  level.openedMs = atMs;
  return mean;
}
