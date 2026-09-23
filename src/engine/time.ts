// Simulated time: milliseconds from Monday 00:00 of the simulated work week. No time zones.
// Days are independent (02-simulator §8, K21): day d covers [d * DAY_MS, (d + 1) * DAY_MS).

export type SimMs = number;
/** 0 = Monday … 4 = Friday. */
export type DayIndex = 0 | 1 | 2 | 3 | 4;

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_DAYS = 5;
export const WEEK_MS = WEEK_DAYS * DAY_MS;
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

/** Simulated time at a day and time of day, e.g. simMs(2, 10, 30) is Wednesday 10:30. */
export function simMs(day: DayIndex, hours: number, minutes = 0, seconds = 0): SimMs {
  return day * DAY_MS + hours * HOUR_MS + minutes * MINUTE_MS + seconds * SECOND_MS;
}

export function dayOf(ms: SimMs): DayIndex {
  const d = Math.floor(ms / DAY_MS);
  if (d < 0 || d >= WEEK_DAYS) throw new RangeError(`Time ${ms} is outside the work week`);
  return d as DayIndex;
}

export function dayStartMs(day: DayIndex): SimMs {
  return day * DAY_MS;
}

/** Milliseconds since midnight of the time's own day. */
export function timeOfDayMs(ms: SimMs): number {
  return ms - Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The High-side rollup for day N is delivered at day N+1, 12:00 (01 §8). Friday's lands after the week. */
export function rollupDeliveryMs(day: DayIndex): SimMs {
  return (day + 1) * DAY_MS + 12 * HOUR_MS;
}

export function isDayIndex(n: number): n is DayIndex {
  return Number.isInteger(n) && n >= 0 && n < WEEK_DAYS;
}
