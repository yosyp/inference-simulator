// Off-shift skipping (05 §5, K16) and the playhead's advance along the playable week.
// The playable week is the five shifts [day·DAY_MS + shift.startMs, day·DAY_MS + shift.endMs).

import type { SimConfig } from '../engine/api.ts';
import { DAY_MS, WEEK_DAYS, type SimMs } from '../engine/time.ts';
import type { ComputedRange } from '../worker/protocol.ts';
import { rangeEndAt } from './ranges.ts';

export type Shift = SimConfig['shift'];

/** End of Friday's shift, where playback stops. */
export function weekEndMs(shift: Shift): SimMs {
  return (WEEK_DAYS - 1) * DAY_MS + shift.endMs;
}

export function inShift(t: SimMs, shift: Shift): boolean {
  const day = Math.floor(t / DAY_MS);
  if (day < 0 || day >= WEEK_DAYS) return false;
  const tod = t - day * DAY_MS;
  return tod >= shift.startMs && tod < shift.endMs;
}

/** t itself if it is in a shift, else the next shift start; null after Friday's shift. */
export function playableAt(t: SimMs, shift: Shift): SimMs | null {
  if (inShift(t, shift)) return t;
  const day = Math.max(0, Math.floor(t / DAY_MS));
  const tod = t - day * DAY_MS;
  const next = t < 0 || tod < shift.startMs ? day : day + 1;
  return next < WEEK_DAYS ? next * DAY_MS + shift.startMs : null;
}

/** End of the shift containing t (t must be in a shift). */
function shiftEndOf(t: SimMs, shift: Shift): SimMs {
  return Math.floor(t / DAY_MS) * DAY_MS + shift.endMs;
}

export interface Advance {
  playheadMs: SimMs;
  /** The playhead stopped at uncomputed time inside a shift. */
  buffering: boolean;
  /** The playhead reached the end of Friday's shift. */
  ended: boolean;
}

/**
 * Moves the playhead forward by simMs of playable time. Off-shift time is skipped: leaving a shift
 * jumps to the next shift start and carries the remainder. The playhead never enters uncomputed
 * time (`computed` must be normalized): it holds at the first uncomputed instant instead.
 */
export function advancePlayhead(
  fromMs: SimMs,
  simMs: number,
  shift: Shift,
  computed: readonly ComputedRange[],
): Advance {
  const end = weekEndMs(shift);
  let t = fromMs;
  let remaining = Math.max(0, simMs);
  for (let guard = 0; guard <= 2 * WEEK_DAYS + 2; guard++) {
    const p = playableAt(t, shift);
    if (p === null) return { playheadMs: Math.max(t, end), buffering: false, ended: true };
    t = p;
    const edge = rangeEndAt(computed, t);
    if (edge === null) return { playheadMs: t, buffering: true, ended: false };
    const segEnd = shiftEndOf(t, shift);
    const limit = Math.min(segEnd, edge);
    if (t + remaining < limit) return { playheadMs: t + remaining, buffering: false, ended: false };
    remaining -= limit - t;
    t = limit;
    if (limit < segEnd) return { playheadMs: t, buffering: true, ended: false };
    if (t >= end) return { playheadMs: end, buffering: false, ended: true };
  }
  return { playheadMs: t, buffering: false, ended: false };
}

/** Whether a playhead at t shows a buffering hold: inside a shift and not computed. */
export function bufferingAt(t: SimMs, shift: Shift, computed: readonly ComputedRange[]): boolean {
  return inShift(t, shift) && rangeEndAt(computed, t) === null;
}
