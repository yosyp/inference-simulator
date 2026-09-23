// Week timeline maths (05 §5, K16): positions along the week, pointer and keyboard targets.
//
// The bar is linear in simulated time, Monday 00:00 to Friday 24:00, with off-shift hours shaded.
// Seeking works in playable time, as playback does: a pointer that lands off-shift snaps to the
// nearer shift edge, and keyboard steps skip nights, so ArrowRight at Monday 16:59 reaches Tuesday
// 07:00, not Monday 17:00 plus fourteen hours of dead time.

import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_DAYS, WEEK_MS, type SimMs } from '../../engine/time.ts';
import type { Shift } from '../../playback/shift.ts';
import { weekEndMs } from '../../playback/shift.ts';
import type { ComputedRange } from '../../worker/protocol.ts';

/** Used when a scenario is running but the store can't say which (not an EngineClientStore). */
export const ALL_DAY_SHIFT: Shift = { startMs: 0, endMs: DAY_MS };

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Position along the bar, 0 at Monday 00:00 and 1 at Friday 24:00. */
export function weekFraction(t: SimMs): number {
  return clamp(t / WEEK_MS, 0, 1);
}

/** A CSS `left` for time t. */
export function leftPercent(t: SimMs): string {
  return `${weekFraction(t) * 100}%`;
}

/** A CSS `width` for [fromMs, toMs). */
export function widthPercent(fromMs: SimMs, toMs: SimMs): string {
  return `${Math.max(0, weekFraction(toMs) - weekFraction(fromMs)) * 100}%`;
}

/** The time under a pointer at clientX over a bar at `rect`; null when the bar has no width. */
export function timeAtClientX(
  clientX: number,
  rect: { left: number; width: number },
): SimMs | null {
  if (!(rect.width > 0)) return null;
  return clamp((clientX - rect.left) / rect.width, 0, 1) * WEEK_MS;
}

/** The playable week: Monday's shift start to Friday's shift end, where playback stops. */
export function weekBounds(shift: Shift): { startMs: SimMs; endMs: SimMs } {
  return { startMs: shift.startMs, endMs: weekEndMs(shift) };
}

/**
 * The nearest playable time. In-shift times are unchanged; off-shift times go to the nearer of the
 * previous shift's end and the next shift's start (ties go to the end), and times outside the
 * playable week clamp to its bounds.
 */
export function snapToShift(t: SimMs, shift: Shift): SimMs {
  const { startMs, endMs } = weekBounds(shift);
  if (t <= startMs) return startMs;
  if (t >= endMs) return endMs;
  const day = Math.floor(t / DAY_MS);
  const tod = t - day * DAY_MS;
  if (tod >= shift.startMs && tod < shift.endMs) return t;
  const prevEnd = (tod >= shift.endMs ? day : day - 1) * DAY_MS + shift.endMs;
  const nextStart = prevEnd - shift.endMs + DAY_MS + shift.startMs;
  return t - prevEnd <= nextStart - t ? prevEnd : nextStart;
}

function shiftLengthMs(shift: Shift): number {
  return shift.endMs - shift.startMs;
}

/** Shift time elapsed before t: the playhead's position with nights removed. */
export function playableOffsetMs(t: SimMs, shift: Shift): number {
  const len = shiftLengthMs(shift);
  if (t <= 0) return 0;
  const day = Math.floor(t / DAY_MS);
  if (day >= WEEK_DAYS) return WEEK_DAYS * len;
  return day * len + clamp(t - day * DAY_MS - shift.startMs, 0, len);
}

/**
 * Inverse of playableOffsetMs. An offset on a shift boundary maps to the next shift's start, and
 * the whole week's shift time maps to the end of Friday's shift.
 */
export function timeAtPlayableOffset(offsetMs: number, shift: Shift): SimMs {
  const len = shiftLengthMs(shift);
  const total = WEEK_DAYS * len;
  const o = clamp(offsetMs, 0, total);
  if (o >= total) return weekEndMs(shift);
  const day = Math.floor(o / len);
  return day * DAY_MS + shift.startMs + (o - day * len);
}

/** Moves t by deltaMs of playable time, skipping nights, and clamps to the playable week. */
export function stepPlayable(t: SimMs, deltaMs: number, shift: Shift): SimMs {
  if (shiftLengthMs(shift) <= 0) return t;
  return timeAtPlayableOffset(playableOffsetMs(t, shift) + deltaMs, shift);
}

export interface KeyInput {
  key: string;
  shiftKey: boolean;
}

/**
 * Where a slider key moves the playhead (APG slider keys), or null for other keys. Arrows step one
 * simulated minute, or an hour with Shift; Page Up and Page Down a day (one shift of playable time,
 * so the same time of day); Home and End the playable week's start and end.
 */
export function keyTarget({ key, shiftKey }: KeyInput, t: SimMs, shift: Shift): SimMs | null {
  const small = shiftKey ? HOUR_MS : MINUTE_MS;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return stepPlayable(t, small, shift);
    case 'ArrowLeft':
    case 'ArrowDown':
      return stepPlayable(t, -small, shift);
    case 'PageUp':
      return stepPlayable(t, shiftLengthMs(shift), shift);
    case 'PageDown':
      return stepPlayable(t, -shiftLengthMs(shift), shift);
    case 'Home':
      return weekBounds(shift).startMs;
    case 'End':
      return weekBounds(shift).endMs;
    default:
      return null;
  }
}

export interface Span {
  fromMs: SimMs;
  toMs: SimMs;
}

/** Off-shift stretches of the week, merged across midnight: Monday morning, four nights, Friday evening. */
export function offShiftSpans(shift: Shift): Span[] {
  const spans: Span[] = [];
  if (shift.startMs > 0) spans.push({ fromMs: 0, toMs: shift.startMs });
  for (let d = 0; d < WEEK_DAYS; d++) {
    const fromMs = d * DAY_MS + shift.endMs;
    const toMs = d === WEEK_DAYS - 1 ? WEEK_MS : (d + 1) * DAY_MS + shift.startMs;
    if (toMs > fromMs) spans.push({ fromMs, toMs });
  }
  return spans;
}

/** Computed ranges clipped to the week, for drawing. */
export function visibleRanges(ranges: readonly ComputedRange[]): Span[] {
  return ranges
    .map((r) => ({ fromMs: Math.max(0, r.fromMs), toMs: Math.min(WEEK_MS, r.toMs) }))
    .filter((r) => r.toMs > r.fromMs);
}
