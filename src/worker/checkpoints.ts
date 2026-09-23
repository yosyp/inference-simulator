// Checkpoint storage per day (04 §3; S1 §6; 00-build §8 G1). The focus day keeps one every 15
// simulated minutes, so a fork or detail request replays at most 15 minutes. Other days keep
// hourly ones within a byte budget (host.ts; at knee load a Server B checkpoint is about 3.6 MB
// with E4 as merged, so only the nearest days keep a few); their mornings are free. A day's
// checkpoints stay valid until a fork cuts before them: one at time t has applied only patches
// dated before t, and holds no detail or tracked-analyst state (both may differ on restore).

import type { DayCheckpoint } from '../engine/api.ts';
import { dayStartMs, type DayIndex, type SimMs } from '../engine/time.ts';

export interface StoredCheckpoint {
  cp: DayCheckpoint;
  /** Estimated retained size. */
  bytes: number;
}

/** Rough retained size of plain data: typed arrays by byteLength, plus per-value overheads. */
export function estimateBytes(value: unknown): number {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') {
      total += typeof v === 'string' ? 16 + 2 * v.length : 8;
      continue;
    }
    if (ArrayBuffer.isView(v)) {
      total += 64 + v.byteLength;
      continue;
    }
    if (v instanceof Map) {
      total += 64;
      for (const [k, x] of v) stack.push(k, x);
      continue;
    }
    if (v instanceof Set) {
      total += 64;
      for (const x of v) stack.push(x);
      continue;
    }
    if (Array.isArray(v)) {
      total += 32;
      for (const x of v) stack.push(x);
      continue;
    }
    total += 32;
    for (const x of Object.values(v)) stack.push(x);
  }
  return total;
}

/** The latest checkpoint at or before atMs, or null (the morning). */
export function latestAtOrBefore(
  list: readonly StoredCheckpoint[],
  atMs: SimMs,
): DayCheckpoint | null {
  let best: DayCheckpoint | null = null;
  for (const s of list) if (s.cp.atMs <= atMs && (!best || s.cp.atMs > best.atMs)) best = s.cp;
  return best;
}

/** Inserts in time order; a checkpoint already stored at the same time wins. */
export function insertCheckpoint(list: StoredCheckpoint[], cp: DayCheckpoint): StoredCheckpoint[] {
  if (list.some((s) => s.cp.atMs === cp.atMs)) return list;
  const out = [...list, { cp, bytes: estimateBytes(cp.state) }];
  out.sort((a, b) => a.cp.atMs - b.cp.atMs);
  return out;
}

/** True when a stored checkpoint serves the interval mark at markMs (the first step reaching it). */
export function covers(list: readonly StoredCheckpoint[], markMs: SimMs, stepMs: number): boolean {
  return list.some((s) => s.cp.atMs >= markMs && s.cp.atMs < markMs + stepMs);
}

/**
 * Thins a day's checkpoints to those serving a multiple of `interval` (the first within stepMs
 * after each mark), as if the day had been computed as a non-focus day. null drops them all.
 */
export function thin(
  list: readonly StoredCheckpoint[],
  day: DayIndex,
  interval: number | null,
  stepMs: number,
): StoredCheckpoint[] {
  if (interval === null) return [];
  const ds = dayStartMs(day);
  const out: StoredCheckpoint[] = [];
  let lastMark = -1;
  for (const s of list) {
    const tod = s.cp.atMs - ds;
    const mark = Math.floor(tod / interval);
    if (mark > lastMark && tod - mark * interval < stepMs) {
      out.push(s);
      lastMark = mark;
    }
  }
  return out;
}

export function totalBytes(list: readonly StoredCheckpoint[]): number {
  return list.reduce((sum, s) => sum + s.bytes, 0);
}
