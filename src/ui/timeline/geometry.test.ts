import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_MS, simMs } from '../../engine/time.ts';
import {
  ALL_DAY_SHIFT,
  keyTarget,
  leftPercent,
  offShiftSpans,
  playableOffsetMs,
  snapToShift,
  stepPlayable,
  timeAtClientX,
  timeAtPlayableOffset,
  visibleRanges,
  weekBounds,
  weekFraction,
  widthPercent,
} from './geometry.ts';
import { describeComputed, formatDayTime, rollupTicks } from './format.ts';

const SHIFT = { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS };
const LEN = 10 * HOUR_MS;

describe('positions', () => {
  it('maps the week linearly onto 0..1 and clamps', () => {
    expect(weekFraction(0)).toBe(0);
    expect(weekFraction(WEEK_MS)).toBe(1);
    expect(weekFraction(simMs(2, 12))).toBe(0.5);
    expect(weekFraction(-5)).toBe(0);
    expect(weekFraction(WEEK_MS * 2)).toBe(1);
    expect(leftPercent(simMs(1, 0))).toBe('20%');
    expect(widthPercent(simMs(1, 0), simMs(3, 0))).toBe('40%');
    expect(widthPercent(simMs(3, 0), simMs(1, 0))).toBe('0%');
  });

  it('turns a pointer x into a time over the bar', () => {
    const rect = { left: 100, width: 1000 };
    expect(timeAtClientX(100, rect)).toBe(0);
    expect(timeAtClientX(1100, rect)).toBe(WEEK_MS);
    expect(timeAtClientX(600, rect)).toBe(WEEK_MS / 2);
    expect(timeAtClientX(50, rect)).toBe(0);
    expect(timeAtClientX(5000, rect)).toBe(WEEK_MS);
    expect(timeAtClientX(500, { left: 0, width: 0 })).toBeNull();
  });
});

describe('snapToShift', () => {
  it('keeps in-shift times', () => {
    expect(snapToShift(simMs(2, 10, 30), SHIFT)).toBe(simMs(2, 10, 30));
    expect(snapToShift(simMs(0, 7), SHIFT)).toBe(simMs(0, 7));
  });

  it('moves off-shift times to the nearer shift edge', () => {
    expect(snapToShift(simMs(1, 20), SHIFT)).toBe(simMs(1, 17)); // evening: back to the shift end
    expect(snapToShift(simMs(2, 3), SHIFT)).toBe(simMs(2, 7)); // small hours: on to the next start
    expect(snapToShift(simMs(1, 23, 59), SHIFT)).toBe(simMs(1, 17));
    expect(snapToShift(simMs(2, 0, 1), SHIFT)).toBe(simMs(2, 7));
    expect(snapToShift(simMs(2, 0), SHIFT)).toBe(simMs(1, 17)); // tie at midnight goes to the end
  });

  it('clamps to the playable week', () => {
    expect(snapToShift(0, SHIFT)).toBe(simMs(0, 7));
    expect(snapToShift(simMs(0, 6), SHIFT)).toBe(simMs(0, 7));
    expect(snapToShift(simMs(4, 20), SHIFT)).toBe(simMs(4, 17));
    expect(snapToShift(WEEK_MS, SHIFT)).toBe(simMs(4, 17));
  });
});

describe('playable time', () => {
  it('removes nights from the offset and puts them back', () => {
    expect(playableOffsetMs(simMs(0, 7), SHIFT)).toBe(0);
    expect(playableOffsetMs(simMs(0, 3), SHIFT)).toBe(0);
    expect(playableOffsetMs(simMs(1, 8), SHIFT)).toBe(LEN + HOUR_MS);
    expect(playableOffsetMs(simMs(1, 20), SHIFT)).toBe(2 * LEN);
    expect(playableOffsetMs(WEEK_MS, SHIFT)).toBe(5 * LEN);
    expect(timeAtPlayableOffset(LEN + HOUR_MS, SHIFT)).toBe(simMs(1, 8));
    expect(timeAtPlayableOffset(LEN, SHIFT)).toBe(simMs(1, 7)); // a boundary is the next start
    expect(timeAtPlayableOffset(5 * LEN, SHIFT)).toBe(simMs(4, 17)); // the week's end
    expect(timeAtPlayableOffset(-1, SHIFT)).toBe(simMs(0, 7));
  });

  it('steps across nights in both directions', () => {
    expect(stepPlayable(simMs(0, 16, 59), MINUTE_MS, SHIFT)).toBe(simMs(1, 7));
    expect(stepPlayable(simMs(1, 7), -MINUTE_MS, SHIFT)).toBe(simMs(0, 16, 59));
    expect(stepPlayable(simMs(1, 16, 30), HOUR_MS, SHIFT)).toBe(simMs(2, 7, 30));
    expect(stepPlayable(simMs(4, 16, 30), HOUR_MS, SHIFT)).toBe(simMs(4, 17));
    expect(stepPlayable(simMs(0, 7, 30), -HOUR_MS, SHIFT)).toBe(simMs(0, 7));
  });

  it('steps from off-shift times as if from the adjoining shift edge', () => {
    expect(stepPlayable(simMs(1, 22), MINUTE_MS, SHIFT)).toBe(simMs(2, 7, 1));
    expect(stepPlayable(simMs(1, 22), -MINUTE_MS, SHIFT)).toBe(simMs(1, 16, 59));
  });

  it('keeps sub-minute offsets', () => {
    expect(stepPlayable(simMs(2, 10, 0, 17.5), MINUTE_MS, SHIFT)).toBe(simMs(2, 10, 1, 17.5));
  });

  it('treats the whole day as playable with the all-day shift', () => {
    expect(stepPlayable(simMs(1, 23, 59), MINUTE_MS, ALL_DAY_SHIFT)).toBe(simMs(2, 0));
    expect(weekBounds(ALL_DAY_SHIFT)).toEqual({ startMs: 0, endMs: WEEK_MS });
  });
});

describe('keyTarget', () => {
  const at = simMs(2, 10, 30);
  const key = (k: string, shiftKey = false) => keyTarget({ key: k, shiftKey }, at, SHIFT);

  it('steps a minute on the arrows and an hour with Shift', () => {
    expect(key('ArrowRight')).toBe(at + MINUTE_MS);
    expect(key('ArrowUp')).toBe(at + MINUTE_MS);
    expect(key('ArrowLeft')).toBe(at - MINUTE_MS);
    expect(key('ArrowDown')).toBe(at - MINUTE_MS);
    expect(key('ArrowRight', true)).toBe(at + HOUR_MS);
    expect(key('ArrowUp', true)).toBe(at + HOUR_MS);
    expect(key('ArrowLeft', true)).toBe(at - HOUR_MS);
    expect(key('ArrowDown', true)).toBe(at - HOUR_MS);
  });

  it('steps a day on Page Up and Page Down, to the same time of day', () => {
    expect(key('PageUp')).toBe(at + DAY_MS);
    expect(key('PageDown')).toBe(at - DAY_MS);
    expect(keyTarget({ key: 'PageUp', shiftKey: false }, simMs(4, 10), SHIFT)).toBe(simMs(4, 17));
    expect(keyTarget({ key: 'PageDown', shiftKey: false }, simMs(0, 10), SHIFT)).toBe(simMs(0, 7));
  });

  it('goes to the playable week’s start and end on Home and End', () => {
    expect(key('Home')).toBe(simMs(0, 7));
    expect(key('End')).toBe(simMs(4, 17));
  });

  it('ignores other keys', () => {
    expect(key('a')).toBeNull();
    expect(key('Enter')).toBeNull();
    expect(key(' ')).toBeNull();
  });
});

describe('spans and ranges', () => {
  it('shades Monday morning, four nights, and Friday evening', () => {
    expect(offShiftSpans(SHIFT)).toEqual([
      { fromMs: 0, toMs: simMs(0, 7) },
      { fromMs: simMs(0, 17), toMs: simMs(1, 7) },
      { fromMs: simMs(1, 17), toMs: simMs(2, 7) },
      { fromMs: simMs(2, 17), toMs: simMs(3, 7) },
      { fromMs: simMs(3, 17), toMs: simMs(4, 7) },
      { fromMs: simMs(4, 17), toMs: WEEK_MS },
    ]);
    expect(offShiftSpans(ALL_DAY_SHIFT)).toEqual([]);
  });

  it('clips computed ranges to the week', () => {
    expect(
      visibleRanges([
        { fromMs: -10, toMs: 10 },
        { fromMs: WEEK_MS - 5, toMs: WEEK_MS + 5 },
        { fromMs: WEEK_MS + 1, toMs: WEEK_MS + 2 },
      ]),
    ).toEqual([
      { fromMs: 0, toMs: 10 },
      { fromMs: WEEK_MS - 5, toMs: WEEK_MS },
    ]);
  });
});

describe('format', () => {
  it('writes the day and the time, rounded down to the minute', () => {
    expect(formatDayTime(simMs(2, 10, 32))).toBe('Wednesday 10:32');
    expect(formatDayTime(simMs(2, 10, 32, 59.9))).toBe('Wednesday 10:32');
    expect(formatDayTime(0)).toBe('Monday 00:00');
    expect(formatDayTime(simMs(4, 17))).toBe('Friday 17:00');
    expect(formatDayTime(WEEK_MS - 1)).toBe('Friday 23:59');
    expect(formatDayTime(-1)).toBe('Monday 00:00');
  });

  it('describes computed ranges, with midnight ends as the end of a day', () => {
    expect(describeComputed([])).toBe('Nothing computed yet.');
    expect(
      describeComputed([
        { fromMs: 0, toMs: simMs(1, 0) },
        { fromMs: simMs(2, 0), toMs: simMs(2, 10, 15) },
      ]),
    ).toBe('Computed: Monday 00:00 to end of Monday; Wednesday 00:00 to Wednesday 10:15.');
    expect(describeComputed([{ fromMs: 0, toMs: WEEK_MS }])).toBe(
      'Computed: Monday 00:00 to end of Friday.',
    );
  });

  it('puts rollup ticks at 12:00 the next day, Monday’s to Thursday’s', () => {
    expect(rollupTicks()).toEqual([
      { day: 0, atMs: simMs(1, 12) },
      { day: 1, atMs: simMs(2, 12) },
      { day: 2, atMs: simMs(3, 12) },
      { day: 3, atMs: simMs(4, 12) },
    ]);
  });
});
