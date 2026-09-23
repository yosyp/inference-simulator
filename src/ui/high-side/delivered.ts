// What the off-site team has received at a playhead (01 §8; 05 §9). One rule for every High-side
// surface: a row is visible once its deliveredAtMs (day N+1, 12:00) is at or before the playhead,
// and the pending days are U4's pendingDaysAt over those rows. ChartStack applies the same filter
// inline; consistency.test.tsx checks the two, and the timeline's arrival ticks, agree.

import { isRollupComputing, pendingDaysAt } from '../../charts/index.ts';
import { formatClock, formatDay } from '../../charts/format.ts';
import type { RollupRow } from '../../engine/results.ts';
import {
  DAY_MS,
  WEEK_DAYS,
  rollupDeliveryMs,
  type DayIndex,
  type SimMs,
} from '../../engine/time.ts';
import type { ResultsIndex } from '../../playback/types.ts';

export const WEEK: readonly DayIndex[] = [0, 1, 2, 3, 4];

/**
 * How a day looks on the High side at a playhead:
 * - `delivered`: its rollup has arrived;
 * - `today`: the playhead's day, not reported until tomorrow 12:00;
 * - `awaiting`: finished, but its rollup arrives later (yesterday before 12:00);
 * - `computing`: its rollup is due, but the engine hasn't finished the day yet (days compute out of
 *   order, lesson day first; K21);
 * - `future`: after the playhead's day.
 */
export type DayStatus = 'delivered' | 'today' | 'awaiting' | 'computing' | 'future';

export interface DeliveredRollup {
  /** The playhead's day, clamped to the week. */
  today: DayIndex;
  replicas: number;
  /** Rows with deliveredAtMs at or before the playhead, by day then replica. */
  rows: readonly RollupRow[];
  /** Days with delivered rows, ascending. */
  deliveredDays: readonly DayIndex[];
  /** Days up to today whose rollup hasn't arrived: U4's pendingDaysAt over `rows`. */
  pendingDays: readonly DayIndex[];
  /** Pending days whose delivery time has passed: the engine hasn't computed them yet. */
  computingDays: readonly DayIndex[];
}

/** The playhead's day, clamped to the week (as pendingDaysAt and the timeline compute it). */
export function dayAtPlayhead(playheadMs: SimMs): DayIndex {
  return Math.min(WEEK_DAYS - 1, Math.max(0, Math.floor(playheadMs / DAY_MS))) as DayIndex;
}

/** The High-side view of `allRows` (index.rollup()) at a playhead. */
export function deliveredRollupAt(
  allRows: readonly RollupRow[],
  playheadMs: SimMs,
  replicas: number,
): DeliveredRollup {
  // The same filter ChartStack applies before drawing DailyBars.
  const rows = allRows
    .filter((r) => r.deliveredAtMs <= playheadMs)
    .sort((a, b) => a.day - b.day || a.replica - b.replica);
  const pendingDays = pendingDaysAt(playheadMs, rows);
  return {
    today: dayAtPlayhead(playheadMs),
    replicas,
    rows,
    deliveredDays: WEEK.filter((d) => rows.some((r) => r.day === d)),
    pendingDays,
    computingDays: pendingDays.filter((d) => isRollupComputing(d, playheadMs)),
  };
}

export function dayStatus(view: DeliveredRollup, day: DayIndex): DayStatus {
  if (view.deliveredDays.includes(day)) return 'delivered';
  if (day > view.today) return 'future';
  if (day === view.today) return 'today';
  return view.computingDays.includes(day) ? 'computing' : 'awaiting';
}

/** "Arrives Thu 12:00", in the words DailyBars uses for a pending day. */
export function arrivalLabel(day: DayIndex): string {
  const at = rollupDeliveryMs(day);
  return `Arrives ${formatDay(at)} ${formatClock(at)}`;
}

function sameRow(a: RollupRow, b: RollupRow): boolean {
  return (
    a === b ||
    (a.day === b.day &&
      a.replica === b.replica &&
      Object.is(a.requestsServed, b.requestsServed) &&
      Object.is(a.meanE2eMs, b.meanE2eMs) &&
      Object.is(a.meanNvidiaSmiUtil, b.meanNvidiaSmiUtil) &&
      a.deliveredAtMs === b.deliveredAtMs)
  );
}

function sameList<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => eq(x, b[i]!)));
}

/**
 * Equal views render the same. Compares row values, not identities, because a ResultsIndex may
 * rebuild its rows on every rollup() call (the fixture index does).
 */
export function sameDelivered(a: DeliveredRollup, b: DeliveredRollup): boolean {
  return (
    a.today === b.today &&
    a.replicas === b.replicas &&
    sameList(a.pendingDays, b.pendingDays, Object.is) &&
    sameList(a.computingDays, b.computingDays, Object.is) &&
    sameList(a.rows, b.rows, sameRow)
  );
}

const rowCache = new WeakMap<ResultsIndex, { version: number; rows: readonly RollupRow[] }>();

/** index.rollup(), called once per index version. */
export function rollupRowsOf(index: ResultsIndex): readonly RollupRow[] {
  const hit = rowCache.get(index);
  if (hit && hit.version === index.version) return hit.rows;
  const rows = index.rollup();
  rowCache.set(index, { version: index.version, rows });
  return rows;
}
