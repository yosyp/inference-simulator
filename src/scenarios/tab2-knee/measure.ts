// Headless measurement for tab 2's lesson (a local helper until C1's src/scenarios/testing lands).
// It runs the lesson day into the same results index the charts read, so a window's TTFT mean and
// p99 are what chart 1 draws for a point of that width.

import { calibration } from '../../data/calibration.ts';
import type { Patch, SimConfig } from '../../engine/api.ts';
import { runHeadless } from '../../engine/headless.ts';
import { FLEET_SERIES } from '../../engine/results.ts';
import { dayOf, dayStartMs, type SimMs } from '../../engine/time.ts';
import { createResultsStore } from '../../playback/index/index.ts';
import type { ResultsIndex, TimeWindow } from '../../playback/types.ts';

export interface WindowStats {
  fromMs: SimMs;
  toMs: SimMs;
  /** First attempts per second (organic arrivals at the router). */
  arrivalsPerS: number;
  ttftMeanMs: number;
  ttftP99Ms: number;
  /** Mean waiting-queue length. */
  waiting: number;
  preemptions: number;
  timedOut: number;
}

/** Runs the day of `untilMs` from its morning to untilMs and returns its results index. */
export function runDayTo(
  config: SimConfig,
  patches: readonly Patch[],
  untilMs: SimMs,
): ResultsIndex {
  const day = dayOf(untilMs - 1);
  const r = runHeadless({
    config,
    calibration,
    patches,
    days: day,
    detail: 'tracked',
    untilTimeOfDayMs: untilMs - dayStartMs(day),
  });
  const store = createResultsStore(config.replicas);
  for (const c of r.days[0]!.chunks) store.addChunk(c);
  return store.index;
}

/** Fleet stats per point of stepMs across the window (one point when stepMs is the window). */
export function windowStats(idx: ResultsIndex, w: TimeWindow, stepMs: number): WindowStats[] {
  const cols = Math.round((w.toMs - w.fromMs) / stepMs);
  const s = (m: Parameters<ResultsIndex['scalarSeries']>[0]) =>
    idx.scalarSeries(m, FLEET_SERIES, w, cols).v;
  const q = idx.quantileSeries('ttft', FLEET_SERIES, w, cols, [0.99]);
  if (q.stepMs !== stepMs || q.t[0] !== w.fromMs) {
    throw new RangeError('The window must start on a multiple of stepMs and span whole steps');
  }
  const sum = s('ttftSumMs');
  const count = s('ttftCount');
  const organic = s('organic');
  const waiting = s('waiting');
  const pre = s('preemptions');
  const tout = s('timedOut');
  return Array.from(q.t, (fromMs, i) => ({
    fromMs,
    toMs: fromMs + q.stepMs,
    arrivalsPerS: organic[i]! / (q.stepMs / 1000),
    ttftMeanMs: sum[i]! / count[i]!,
    ttftP99Ms: q.values[0]![i]!,
    waiting: waiting[i]!,
    preemptions: pre[i]!,
    timedOut: tout[i]!,
  }));
}

/**
 * The day's 50%-load point: the first point, from the shift's start, whose arrival rate reaches
 * half the rate of `reference` (the lesson window, which runs near capacity).
 */
export function halfLoadPoint(
  idx: ResultsIndex,
  shiftStartMs: SimMs,
  reference: WindowStats,
  stepMs: number,
): WindowStats {
  const points = windowStats(idx, { fromMs: shiftStartMs, toMs: reference.fromMs }, stepMs);
  const p = points.find((x) => x.arrivalsPerS >= reference.arrivalsPerS / 2);
  if (!p) throw new Error('Arrivals never reach half the lesson window’s rate before it');
  return p;
}
