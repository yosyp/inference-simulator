// Window aggregation over headless chunks: the exact numbers behind a chart's points (05 §6).
//
// A bucket counts toward a window when its start lies in [fromMs, toMs). Windows on bucket
// boundaries are exact: scalars are 10 s buckets and histograms 60 s (G1), so a window on whole
// minutes is exact for both. Buckets exist only over each day's active window; a window with no
// bucket reads NaN.

import {
  HISTOGRAM_SPECS,
  addSparseCellInto,
  quantile,
  totalCount,
  type HistogramMetric,
} from '../../engine/histogram.ts';
import {
  FLEET_SERIES,
  SCALAR_METRICS,
  type ScalarBlock,
  type ScalarMetric,
} from '../../engine/results.ts';
import type { SimMs } from '../../engine/time.ts';
import type { TimeWindow } from '../../playback/types.ts';
import type { ChunkRun } from './run.ts';

export type { TimeWindow };

export function win(fromMs: SimMs, toMs: SimMs): TimeWindow {
  return { fromMs, toMs };
}

/** [atMs − spanMs, atMs). */
export function before(atMs: SimMs, spanMs: number): TimeWindow {
  return { fromMs: atMs - spanMs, toMs: atMs };
}

/** [atMs, atMs + spanMs). */
export function after(atMs: SimMs, spanMs: number): TimeWindow {
  return { fromMs: atMs, toMs: atMs + spanMs };
}

/** Calls fn for each scalar bucket starting in the window, in time order. */
export function forEachScalarBucket(
  run: ChunkRun,
  window: TimeWindow,
  fn: (block: ScalarBlock, bucket: number, startMs: SimMs) => void,
): void {
  for (const c of run.chunks) {
    const b = c.scalars;
    if (b.count === 0) continue;
    const end = b.startMs + b.count * b.bucketMs;
    if (end <= window.fromMs || b.startMs >= window.toMs) continue;
    const lo = Math.max(0, Math.ceil((window.fromMs - b.startMs) / b.bucketMs));
    const hi = Math.min(b.count, Math.ceil((window.toMs - b.startMs) / b.bucketMs));
    for (let i = lo; i < hi; i++) fn(b, i, b.startMs + i * b.bucketMs);
  }
}

export interface ScalarWindow {
  /** Aggregated as SCALAR_METRICS says: 'sum' totals, 'mean' averages, 'max' maxes. NaN if no bucket. */
  value: number;
  /** Simulated ms covered by the buckets present. */
  ms: number;
}

/** A scalar metric over the window, for one series (0 = fleet, r + 1 = replica r). */
export function scalarWindow(
  run: ChunkRun,
  metric: ScalarMetric,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): ScalarWindow {
  const agg = SCALAR_METRICS[metric];
  let acc = agg === 'max' ? -Infinity : 0;
  let n = 0;
  let ms = 0;
  forEachScalarBucket(run, window, (b, i) => {
    if (series >= b.series) return;
    const v = b.data[metric][i * b.series + series]!;
    acc = agg === 'max' ? Math.max(acc, v) : acc + v;
    n++;
    ms += b.bucketMs;
  });
  if (n === 0) return { value: NaN, ms: 0 };
  return { value: agg === 'mean' ? acc / n : acc, ms };
}

/** scalarWindow(...).value. */
export function scalarIn(
  run: ChunkRun,
  metric: ScalarMetric,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): number {
  return scalarWindow(run, metric, window, series).value;
}

/** Evenly spaced values: v[i] covers [t[i], t[i] + stepMs). */
export interface Points {
  t: number[];
  v: number[];
  stepMs: number;
}

/** One point per scalar bucket in the window (the bucket's own value). */
export function scalarPoints(
  run: ChunkRun,
  metric: ScalarMetric,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): Points {
  const t: number[] = [];
  const v: number[] = [];
  let stepMs = 0;
  forEachScalarBucket(run, window, (b, i, start) => {
    if (series >= b.series) return;
    stepMs = b.bucketMs;
    t.push(start);
    v.push(b.data[metric][i * b.series + series]!);
  });
  return { t, v, stepMs };
}

/** The merged histogram (exact) of every histogram bucket starting in the window. */
export function histogramIn(
  run: ChunkRun,
  metric: HistogramMetric,
  window: TimeWindow,
  series: number = FLEET_SERIES,
): Uint32Array {
  const out = new Uint32Array(HISTOGRAM_SPECS[metric].bins);
  for (const c of run.chunks) {
    const h = c.histograms;
    if (h.count === 0 || series >= h.series) continue;
    const lo = Math.max(0, Math.ceil((window.fromMs - h.startMs) / h.bucketMs));
    const hi = Math.min(h.count, Math.ceil((window.toMs - h.startMs) / h.bucketMs));
    for (let i = lo; i < hi; i++) addSparseCellInto(out, 0, h.data[metric], i * h.series + series);
  }
  return out;
}

/** Quantiles (0 < q <= 1) of the merged histogram; NaN when it is empty. ~7% bin resolution. */
export function quantilesIn(
  run: ChunkRun,
  metric: HistogramMetric,
  window: TimeWindow,
  quantiles: readonly number[],
  series: number = FLEET_SERIES,
): number[] {
  const spec = HISTOGRAM_SPECS[metric];
  const h = histogramIn(run, metric, window, series);
  if (totalCount(h, 0, spec.bins) === 0) return quantiles.map(() => NaN);
  return quantiles.map((q) => quantile(spec, h, 0, q));
}

/** Evaluates fn on consecutive windows of stepMs covering the window (the last may be short). */
export function slide(window: TimeWindow, stepMs: number, fn: (w: TimeWindow) => number): Points {
  if (!(stepMs > 0)) throw new RangeError(`stepMs ${stepMs} must be positive`);
  const t: number[] = [];
  const v: number[] = [];
  for (let s = window.fromMs; s < window.toMs; s += stepMs) {
    t.push(s);
    v.push(fn({ fromMs: s, toMs: Math.min(window.toMs, s + stepMs) }));
  }
  return { t, v, stepMs };
}

export interface Run {
  /** Length of the longest stretch of consecutive points where the predicate holds. */
  ms: number;
  /** That stretch, or null if the predicate never holds. */
  window: TimeWindow | null;
  /** Total time the predicate holds. */
  totalMs: number;
}

/** The longest stretch of consecutive points (no time gap between them) where pred holds. */
export function longestRun(points: Points, pred: (v: number) => boolean): Run {
  let best: TimeWindow | null = null;
  let cur: TimeWindow | null = null;
  let totalMs = 0;
  for (let i = 0; i < points.t.length; i++) {
    const t = points.t[i]!;
    if (!pred(points.v[i]!)) {
      cur = null;
      continue;
    }
    totalMs += points.stepMs;
    if (cur && cur.toMs === t) cur.toMs = t + points.stepMs;
    else cur = { fromMs: t, toMs: t + points.stepMs };
    if (!best || cur.toMs - cur.fromMs > best.toMs - best.fromMs) best = { ...cur };
  }
  return { ms: best ? best.toMs - best.fromMs : 0, window: best, totalMs };
}

/** The start of the first point where pred holds, or null. */
export function firstWhere(points: Points, pred: (v: number) => boolean): SimMs | null {
  for (let i = 0; i < points.t.length; i++) if (pred(points.v[i]!)) return points.t[i]!;
  return null;
}
