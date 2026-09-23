// The delivery rule (01 §8, 05 §9): day N's rollup is visible from day N+1 12:00, the current day
// is never visible, and the rule is ChartStack's own (filter by deliveredAtMs, then pendingDaysAt).

import { describe, expect, it } from 'vitest';
import { pendingDaysAt } from '../../charts/index.ts';
import type { RollupRow } from '../../engine/results.ts';
import { DAY_MS, MINUTE_MS, WEEK_MS, simMs } from '../../engine/time.ts';
import { createFakeIndex } from '../../fixtures/fake-index.ts';
import type { ResultsIndex } from '../../playback/types.ts';
import {
  arrivalLabel,
  dayStatus,
  deliveredRollupAt,
  rollupRowsOf,
  sameDelivered,
  WEEK,
  type DayStatus,
} from './delivered.ts';

const index = createFakeIndex({ replicas: 8 });
const all = index.rollup();

function statuses(t: number, rows: readonly RollupRow[] = all): DayStatus[] {
  const view = deliveredRollupAt(rows, t, 8);
  return WEEK.map((d) => dayStatus(view, d));
}

describe('deliveredRollupAt', () => {
  it.each([
    // [label, playhead, delivered days, pending days, statuses Mon..Fri]
    ['Monday 10:00', simMs(0, 10), [], [0], ['today', 'future', 'future', 'future', 'future']],
    [
      'Tuesday 11:59:59.999',
      simMs(1, 12) - 1,
      [],
      [0, 1],
      ['awaiting', 'today', 'future', 'future', 'future'],
    ],
    ['Tuesday 12:00', simMs(1, 12), [0], [1], ['delivered', 'today', 'future', 'future', 'future']],
    [
      'Wednesday 14:00',
      simMs(2, 14),
      [0, 1],
      [2],
      ['delivered', 'delivered', 'today', 'future', 'future'],
    ],
    [
      'Thursday 09:00',
      simMs(3, 9),
      [0, 1],
      [2, 3],
      ['delivered', 'delivered', 'awaiting', 'today', 'future'],
    ],
    [
      'Friday 12:00',
      simMs(4, 12),
      [0, 1, 2, 3],
      [4],
      ['delivered', 'delivered', 'delivered', 'delivered', 'today'],
    ],
    [
      'the end of the week',
      WEEK_MS - 1,
      [0, 1, 2, 3],
      [4],
      ['delivered', 'delivered', 'delivered', 'delivered', 'today'],
    ],
  ] as const)('at %s', (_label, t, delivered, pending, want) => {
    const view = deliveredRollupAt(all, t, 8);
    expect(view.deliveredDays).toEqual(delivered);
    expect(view.pendingDays).toEqual(pending);
    expect(view.rows).toHaveLength(delivered.length * 8);
    expect(view.computingDays).toEqual([]);
    expect(statuses(t)).toEqual(want);
  });

  it('is exactly ChartStack’s rule at every 30 minutes of the week', () => {
    for (let t = 0; t < WEEK_MS; t += 30 * MINUTE_MS) {
      const inline = all.filter((r) => r.deliveredAtMs <= t);
      const view = deliveredRollupAt(all, t, 8);
      expect(view.rows).toEqual(inline);
      expect(view.pendingDays).toEqual(pendingDaysAt(t, inline));
      // The current day never shows.
      expect(view.rows.some((r) => r.day === Math.floor(t / DAY_MS))).toBe(false);
    }
  });

  it('marks due days the engine has not computed yet as computing', () => {
    // Days compute out of order, lesson day first (K21): here only Wednesday is done.
    const wednesday = all.filter((r) => r.day === 2);
    const atWed = deliveredRollupAt(wednesday, simMs(2, 14), 8);
    expect(atWed.deliveredDays).toEqual([]);
    expect(atWed.pendingDays).toEqual([0, 1, 2]);
    expect(atWed.computingDays).toEqual([0, 1]);
    expect(statuses(simMs(2, 14), wednesday)).toEqual([
      'computing',
      'computing',
      'today',
      'future',
      'future',
    ]);
    // Wednesday lands on time even though Monday and Tuesday are still computing.
    expect(statuses(simMs(3, 12), wednesday)).toEqual([
      'computing',
      'computing',
      'delivered',
      'today',
      'future',
    ]);
  });

  it('sorts rows by day, then replica', () => {
    const shuffled = [...all].reverse();
    const view = deliveredRollupAt(shuffled, simMs(4, 13), 8);
    expect(view.rows.map((r) => [r.day, r.replica])).toEqual(
      all.filter((r) => r.day < 4).map((r) => [r.day, r.replica]),
    );
  });
});

describe('arrivalLabel', () => {
  it('names the next day at 12:00, in DailyBars’ words', () => {
    expect(WEEK.map((d) => arrivalLabel(d))).toEqual([
      'Arrives Tue 12:00',
      'Arrives Wed 12:00',
      'Arrives Thu 12:00',
      'Arrives Fri 12:00',
      'Arrives Sat 12:00',
    ]);
  });
});

describe('sameDelivered', () => {
  it('holds between arrivals and midnights, even when the index rebuilds its rows', () => {
    const a = deliveredRollupAt(index.rollup(), simMs(2, 12), 8);
    const b = deliveredRollupAt(index.rollup(), simMs(2, 23, 59), 8);
    expect(a.rows[0]).not.toBe(b.rows[0]);
    expect(sameDelivered(a, b)).toBe(true);
  });

  it('breaks at 12:00 and at midnight', () => {
    const base = deliveredRollupAt(all, simMs(2, 11, 59), 8);
    expect(sameDelivered(base, deliveredRollupAt(all, simMs(2, 12), 8))).toBe(false);
    const thu = deliveredRollupAt(all, simMs(3, 0), 8);
    expect(sameDelivered(deliveredRollupAt(all, simMs(2, 23), 8), thu)).toBe(false);
  });

  it('breaks when a delivered value changes (a fork recomputed the day)', () => {
    const changed = all.map((r) =>
      r.day === 0 && r.replica === 2 ? { ...r, requestsServed: r.requestsServed - 500 } : r,
    );
    const t = simMs(2, 14);
    expect(sameDelivered(deliveredRollupAt(all, t, 8), deliveredRollupAt(changed, t, 8))).toBe(
      false,
    );
  });
});

describe('rollupRowsOf', () => {
  it('calls rollup() once per index version', () => {
    let version = 1;
    let calls = 0;
    const counted: ResultsIndex = {
      ...index,
      get version() {
        return version;
      },
      rollup: () => {
        calls++;
        return all;
      },
    };
    rollupRowsOf(counted);
    rollupRowsOf(counted);
    expect(calls).toBe(1);
    version++;
    rollupRowsOf(counted);
    expect(calls).toBe(2);
  });
});
