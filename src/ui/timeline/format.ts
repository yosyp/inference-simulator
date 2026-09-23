// Text for the week timeline: the readout, aria-valuetext, and the computed-range description.

import {
  DAY_MS,
  DAY_NAMES,
  MINUTE_MS,
  WEEK_DAYS,
  rollupDeliveryMs,
  type DayIndex,
  type SimMs,
} from '../../engine/time.ts';
import type { ComputedRange } from '../../worker/protocol.ts';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The day a time falls on, clamped to the week. */
export function dayAt(t: SimMs): DayIndex {
  return Math.min(WEEK_DAYS - 1, Math.max(0, Math.floor(t / DAY_MS))) as DayIndex;
}

/** "Wednesday 10:32": day name and 24-hour time, rounded down to the minute. */
export function formatDayTime(t: SimMs): string {
  const ms = Math.max(0, t);
  const day = dayAt(ms);
  const minutes = Math.floor((ms - day * DAY_MS) / MINUTE_MS);
  return `${DAY_NAMES[day]} ${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** The exclusive end of a range: "end of Wednesday" on a midnight, else the day and time. */
function formatRangeEnd(t: SimMs): string {
  const day = t / DAY_MS;
  if (Number.isInteger(day) && day >= 1 && day <= WEEK_DAYS) return `end of ${DAY_NAMES[day - 1]}`;
  return formatDayTime(t);
}

/** Screen-reader summary of what the engine has computed so far. */
export function describeComputed(ranges: readonly ComputedRange[]): string {
  if (ranges.length === 0) return 'Nothing computed yet.';
  const parts = ranges.map((r) => `${formatDayTime(r.fromMs)} to ${formatRangeEnd(r.toMs)}`);
  return `Computed: ${parts.join('; ')}.`;
}

export interface RollupTick {
  day: DayIndex;
  atMs: SimMs;
}

/** When each day's High-side rollup arrives inside the week (01 §8): Monday's to Thursday's. */
export function rollupTicks(): RollupTick[] {
  const ticks: RollupTick[] = [];
  for (let d = 0; d < WEEK_DAYS; d++) {
    const atMs = rollupDeliveryMs(d as DayIndex);
    if (atMs < WEEK_DAYS * DAY_MS) ticks.push({ day: d as DayIndex, atMs });
  }
  return ticks;
}
