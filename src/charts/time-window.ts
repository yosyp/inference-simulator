// The charts' shared time window and zoom (05 §6). The three charts always show the same window,
// and the window always contains the playhead.
//
// Default: the playhead's shift day, e.g. Wednesday 07:00–17:00. It follows the playhead to the next
// day when playback skips the night.
//
// Zoomed: a narrower span (ZOOM_SPANS_MS) laid out as pages. A ChartView fixes the span and one
// page's start (anchorMs); the window is the page that contains the playhead, clamped inside its
// shift. As playback reaches the right edge the window flips to the next page, so the charts follow
// the playhead without sliding under it on every frame. Zooming keeps the focus time (the playhead
// for the buttons, the pointer for ctrl/⌘ + wheel) at the same pixel; if the playhead would fall
// outside the zoomed window, the window shows the playhead's page instead. Reset returns to the
// shift day. The window is a pure function of (view, playhead, shift).

import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_DAYS, type SimMs } from '../engine/time.ts';
import type { TimeWindow } from '../playback/types.ts';
import { formatClock, formatDay } from './format.ts';

export interface Shift {
  /** Time of day, ms. */
  startMs: number;
  endMs: number;
}

/** A zoomed view; null means the default shift-day window. */
export interface ChartView {
  spanMs: number;
  /** Start of one page; pages repeat every spanMs from here. */
  anchorMs: SimMs;
}

/** Zoom steps below the shift day, widest first. */
export const ZOOM_SPANS_MS: readonly number[] = [
  4 * HOUR_MS,
  2 * HOUR_MS,
  HOUR_MS,
  30 * MINUTE_MS,
  15 * MINUTE_MS,
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The shift of the playhead's day: [day + shift.start, day + shift.end). */
export function shiftWindow(atMs: SimMs, shift: Shift): TimeWindow {
  const day = clamp(Math.floor(atMs / DAY_MS), 0, WEEK_DAYS - 1);
  return { fromMs: day * DAY_MS + shift.startMs, toMs: day * DAY_MS + shift.endMs };
}

/** Available spans, widest (the shift day) first. */
export function zoomSpans(shift: Shift): number[] {
  const day = shift.endMs - shift.startMs;
  return [day, ...ZOOM_SPANS_MS.filter((s) => s < day)];
}

/** The window for a view at this playhead position. */
export function resolveWindow(view: ChartView | null, playheadMs: SimMs, shift: Shift): TimeWindow {
  const day = shiftWindow(playheadMs, shift);
  if (!view || view.spanMs >= day.toMs - day.fromMs) return day;
  const span = view.spanMs;
  const page = Math.floor((playheadMs - view.anchorMs) / span);
  const from = clamp(view.anchorMs + page * span, day.fromMs, day.toMs - span);
  return { fromMs: from, toMs: from + span };
}

function spanOf(w: TimeWindow): number {
  return w.toMs - w.fromMs;
}

/** A view with the given span that keeps focusMs at the same relative position as in `current`. */
function viewAround(
  span: number,
  current: TimeWindow,
  focusMs: SimMs,
  shift: Shift,
): ChartView | null {
  if (span >= shift.endMs - shift.startMs) return null;
  const f = clamp(focusMs, current.fromMs, current.toMs);
  const rel = spanOf(current) > 0 ? (f - current.fromMs) / spanOf(current) : 0.5;
  return { spanMs: span, anchorMs: f - rel * span };
}

export function canZoomIn(current: TimeWindow, shift: Shift): boolean {
  return zoomSpans(shift).some((s) => s < spanOf(current) - 1);
}

export function canZoomOut(view: ChartView | null): boolean {
  return view !== null;
}

/** One step narrower, keeping focusMs in place. Returns `view` unchanged at the narrowest span. */
export function zoomIn(
  view: ChartView | null,
  current: TimeWindow,
  focusMs: SimMs,
  shift: Shift,
): ChartView | null {
  const next = zoomSpans(shift).find((s) => s < spanOf(current) - 1);
  return next === undefined ? view : viewAround(next, current, focusMs, shift);
}

/** One step wider, keeping focusMs in place; the widest step is the default view (null). */
export function zoomOut(
  view: ChartView | null,
  current: TimeWindow,
  focusMs: SimMs,
  shift: Shift,
): ChartView | null {
  if (!view) return null;
  const wider = zoomSpans(shift).filter((s) => s > spanOf(current) + 1);
  const next = wider[wider.length - 1];
  return next === undefined ? null : viewAround(next, current, focusMs, shift);
}

/** "Wed 07:00–17:00". */
export function windowLabel(w: TimeWindow): string {
  return `${formatDay(w.fromMs)} ${formatClock(w.fromMs)}–${formatClock(w.toMs)}`;
}

const TICK_STEPS_MS = [
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
];

/** Clock-aligned ticks inside the window, at most maxTicks of them (e.g. every hour on the hour). */
export function timeTicks(w: TimeWindow, maxTicks: number): SimMs[] {
  const span = spanOf(w);
  if (!(span > 0) || maxTicks < 1) return [];
  const step = TICK_STEPS_MS.find((s) => Math.floor(span / s) + 1 <= maxTicks) ?? DAY_MS;
  const out: SimMs[] = [];
  for (let t = Math.ceil(w.fromMs / step) * step; t <= w.toMs; t += step) out.push(t);
  return out;
}
