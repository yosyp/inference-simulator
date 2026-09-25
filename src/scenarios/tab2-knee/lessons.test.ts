// Tab 2 lesson assertions (00-build §7.3). Runs Wednesday headless to the end of the spike hour.
// Measured on the measured calibration (X4; seed 1, 1.8× spike): 50%-load point 09:10 (mean 186 ms,
// p99 1,060 ms); spike hour 10:00–11:00 (2.47 requests/s, mean 768 ms, p99 10,467 ms): p99 rose
// 16.2× as many ms as the mean, ended 9.9× its 50%-load value and 13.6× the hour's mean. Without the
// spike, 10:00–11:00 gives 6.6×, 4.7×, and 5.5×. First 1-minute p99 burst: 10:07, 15.6 s of wall
// time after entry at 50×. Spikes of 1.75× and 1.85× also pass; 1.7× fails (4.2×) and 1.9× collapses.

import { beforeAll, describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, SECOND_MS, dayOf, simMs } from '../../engine/time.ts';
import type { ResultsIndex } from '../../playback/types.ts';
import { LESSON_SPIKE_MS, scenario } from './index.ts';
import { halfLoadPoint, runDayTo, windowStats, type WindowStats } from './measure.ts';

const moment = scenario.lessonMoment.atMs;
const lessonWindow = { fromMs: moment, toMs: moment + LESSON_SPIKE_MS };
const shiftStart = simMs(dayOf(moment), 0) + scenario.sim.shift.startMs;

let idx: ResultsIndex;
let lesson: WindowStats;
let half: WindowStats;

beforeAll(() => {
  idx = runDayTo(scenario.sim, scenario.baselinePatches, lessonWindow.toMs);
  lesson = windowStats(idx, lessonWindow, LESSON_SPIKE_MS)[0]!;
  half = halfLoadPoint(idx, shiftStart, lesson, 10 * MINUTE_MS);
}, 20_000);

describe('tab 2 · saturation knee', () => {
  it('opens paused shortly before a Monday-to-Thursday moment, within 45 s at the entry speed', () => {
    expect(dayOf(moment)).toBeLessThanOrEqual(3);
    expect(scenario.entry.atMs).toBeLessThan(moment);
    expect((moment - scenario.entry.atMs) / scenario.entry.speed).toBeLessThanOrEqual(
      45 * SECOND_MS,
    );
    expect(scenario.baselinePatches.some((p) => p.atMs === moment)).toBe(true);
  });

  it('runs the spike hour near capacity: arrivals double from the 50%-load point, no timeouts', () => {
    expect(half.fromMs).toBeGreaterThanOrEqual(shiftStart + HOUR_MS);
    expect(lesson.arrivalsPerS).toBeGreaterThan(1.8);
    expect(lesson.waiting).toBeGreaterThan(0.3);
    expect(lesson.preemptions).toBeGreaterThan(0);
    expect(lesson.timedOut).toBe(0);
  });

  it('p99 climbs far more than the mean, and the hour’s mean hides it', () => {
    const meanRise = lesson.ttftMeanMs - half.ttftMeanMs;
    const p99Rise = lesson.ttftP99Ms - half.ttftP99Ms;
    expect(meanRise).toBeGreaterThan(0);
    expect(p99Rise).toBeGreaterThanOrEqual(8 * meanRise);
    expect(lesson.ttftP99Ms).toBeGreaterThanOrEqual(5 * half.ttftP99Ms);
    expect(lesson.ttftP99Ms).toBeGreaterThanOrEqual(8 * lesson.ttftMeanMs);
  });

  it('shows a p99 burst on chart 1 within 45 s of Play', () => {
    const minutes = windowStats(idx, lessonWindow, MINUTE_MS);
    const burst = minutes.find((p) => p.ttftP99Ms >= 3 * half.ttftP99Ms);
    expect(burst).toBeDefined();
    const wallMs = (burst!.toMs - scenario.entry.atMs) / scenario.entry.speed;
    expect(wallMs).toBeLessThanOrEqual(45 * SECOND_MS);
  });
});
