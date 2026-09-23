// Where streamed chunks end and where checkpoints fall (00-build §8 G1 decisions; S1 §6).
//
// - Chunks end on a 5-minute grid from the day's midnight.
// - Each off-shift stretch is one chunk: midnight to the active window's start, and the window's
//   end to midnight. The active window is the shift, widened to whole histogram buckets.
// - After a fork the first chunk is 1 minute. After init and focus, the chunk that reaches the
//   focus time ends at the first 1-minute mark after it, so the first frame waits less.
// - Checkpoints fall where a chunk (or a silent step) reaches a multiple of the interval inside
//   the active window: every 15 minutes on the focus day, hourly (budget permitting) elsewhere.
//
// Every boundary is a multiple of histBucketMs, so fork cuts, buckets, and chunks line up.

import type { SimConfig } from '../engine/api.ts';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  dayStartMs,
  type DayIndex,
  type SimMs,
} from '../engine/time.ts';

export interface GridOptions {
  chunkMs?: number;
  firstChunkMs?: number;
  focusCheckpointMs?: number;
  /** null: no checkpoints on days other than the focus day. */
  otherCheckpointMs?: number | null;
}

export interface Grid {
  /** Streamed chunk width. */
  chunkMs: number;
  /** First chunk after a fork, and the cut after the focus time. */
  firstChunkMs: number;
  /** Active window as time of day: [activeStartMs, activeEndMs). */
  activeStartMs: number;
  activeEndMs: number;
  focusCheckpointMs: number;
  otherCheckpointMs: number | null;
}

function roundUp(ms: number, step: number): number {
  return Math.max(step, Math.ceil(ms / step) * step);
}

export function createGrid(config: SimConfig, options: GridOptions = {}): Grid {
  const hb = config.histBucketMs;
  const chunkMs = roundUp(options.chunkMs ?? 5 * MINUTE_MS, hb);
  const firstChunkMs = Math.min(chunkMs, roundUp(options.firstChunkMs ?? MINUTE_MS, hb));
  const clampDay = (t: number) => Math.min(DAY_MS, Math.max(0, t));
  const activeStartMs = Math.floor(clampDay(config.shift.startMs) / hb) * hb;
  const activeEndMs = Math.max(
    activeStartMs,
    Math.min(DAY_MS, Math.ceil(clampDay(config.shift.endMs) / hb) * hb),
  );
  const other = options.otherCheckpointMs === undefined ? HOUR_MS : options.otherCheckpointMs;
  return {
    chunkMs,
    firstChunkMs,
    activeStartMs,
    activeEndMs,
    focusCheckpointMs: roundUp(options.focusCheckpointMs ?? 15 * MINUTE_MS, hb),
    otherCheckpointMs: other === null ? null : roundUp(other, hb),
  };
}

export interface ChunkEndOptions {
  /** The first chunk after a fork: at most firstChunkMs. */
  first: boolean;
  /** End the chunk that reaches this time at the next firstChunkMs mark after it. */
  targetMs: SimMs | null;
}

/** End of the streamed chunk that starts at fromMs (a multiple of histBucketMs) on `day`. */
export function nextChunkEnd(
  g: Grid,
  day: DayIndex,
  fromMs: SimMs,
  opts: ChunkEndOptions = { first: false, targetMs: null },
): SimMs {
  const ds = dayStartMs(day);
  const tod = fromMs - ds;
  if (tod < g.activeStartMs) return ds + g.activeStartMs;
  if (tod >= g.activeEndMs) return ds + DAY_MS;
  let end = Math.min(ds + (Math.floor(tod / g.chunkMs) + 1) * g.chunkMs, ds + g.activeEndMs);
  if (opts.first) end = Math.min(end, fromMs + g.firstChunkMs);
  const t = opts.targetMs;
  if (t !== null && fromMs <= t && t < end) {
    end = Math.min(end, ds + (Math.floor((t - ds) / g.firstChunkMs) + 1) * g.firstChunkMs);
  }
  return end;
}

/** End of the next silent step (a replay nobody sees) from fromMs toward limitMs. */
export function nextSilentEnd(g: Grid, day: DayIndex, fromMs: SimMs, limitMs: SimMs): SimMs {
  return Math.min(limitMs, nextChunkEnd(g, day, fromMs));
}

/** The checkpoint interval for a day: focus or other (null: none). */
export function checkpointInterval(g: Grid, isFocus: boolean): number | null {
  return isFocus ? g.focusCheckpointMs : g.otherCheckpointMs;
}

/**
 * True when a step from fromMs to toMs reached a multiple of `interval` inside the active window,
 * so a checkpoint belongs at toMs. The morning (the active start) is free: createDayRun.
 */
export function checkpointDue(
  g: Grid,
  day: DayIndex,
  fromMs: SimMs,
  toMs: SimMs,
  interval: number | null,
): boolean {
  if (interval === null) return false;
  const ds = dayStartMs(day);
  const to = toMs - ds;
  if (!(to > g.activeStartMs && to <= g.activeEndMs)) return false;
  return Math.floor(to / interval) > Math.floor((fromMs - ds) / interval);
}
