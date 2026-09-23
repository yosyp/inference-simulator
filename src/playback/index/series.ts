// Chart series (05 §6): at most one point per pixel column, each point aggregating whole buckets.
// Scalars use their metric's aggregation kind; percentiles come from exactly merged histograms.

import {
  HISTOGRAM_SPECS,
  addSparseCellInto,
  quantile,
  totalCount,
  type HistogramMetric,
} from '../../engine/histogram.ts';
import {
  SCALAR_METRICS,
  type HistogramBlock,
  type ScalarBlock,
  type ScalarMetric,
} from '../../engine/results.ts';
import { quietScalar } from '../../engine/metrics/quiet.ts';
import type { QuantileData, SeriesData, TimeWindow } from '../types.ts';
import { forEachRun, type SlotIndex } from './slots.ts';

/** Step used before any bucket has arrived, when every point is NaN anyway. */
const FALLBACK_STEP_MS = 1_000;

export interface Grid {
  /** First point's start: a multiple of stepMs, at or before window.fromMs. */
  t0: number;
  n: number;
  stepMs: number;
}

/**
 * The smallest step that is a multiple of baseMs and covers the window in at most `columns`
 * points. Points start at multiples of the step, so panning never shifts bucket boundaries.
 */
export function chooseGrid(window: TimeWindow, columns: number, baseMs: number): Grid {
  const span = window.toMs - window.fromMs;
  const cols = Math.max(1, Math.floor(columns));
  if (!(span > 0)) return { t0: window.fromMs, n: 0, stepMs: baseMs };
  let k = Math.max(1, Math.ceil(span / (cols * baseMs)));
  for (;;) {
    const stepMs = k * baseMs;
    const t0 = Math.floor(window.fromMs / stepMs) * stepMs;
    const n = Math.ceil((window.toMs - t0) / stepMs);
    if (n <= cols) return { t0, n, stepMs };
    k += Math.max(1, Math.floor(k / 16));
  }
}

export function scalarSeries(
  index: SlotIndex<ScalarBlock>,
  metric: ScalarMetric,
  series: number,
  window: TimeWindow,
  columns: number,
): SeriesData {
  const bucketMs = index.bucketMs;
  const { t0, n, stepMs } = chooseGrid(window, columns, bucketMs || FALLBACK_STEP_MS);
  const t = new Float64Array(n);
  const v = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) t[i] = t0 + i * stepMs;
  if (bucketMs === 0) return { t, stepMs, v };

  const agg = SCALAR_METRICS[metric];
  const perPoint = stepMs / bucketMs;
  let acc = 0;
  let present = 0;
  const replicas = index.series - 1;
  const quiet = series >= 0 && series <= replicas ? quietScalar(metric, series, replicas) : NaN;
  const visit = (block: ScalarBlock | null, bucket: number, count: number) => {
    if (!block) {
      if (Number.isNaN(quiet)) return;
      if (agg === 'max') acc = Math.max(acc, quiet);
      else acc += quiet * count;
      present += count;
      return;
    }
    const stride = block.series;
    if (series < 0 || series >= stride) return;
    const data = block.data[metric];
    let idx = bucket * stride + series;
    if (agg === 'max') {
      for (let k = 0; k < count; k++, idx += stride) if (data[idx]! > acc) acc = data[idx]!;
    } else {
      for (let k = 0; k < count; k++, idx += stride) acc += data[idx]!;
    }
    present += count;
  };
  let g = t0 / bucketMs;
  for (let i = 0; i < n; i++, g += perPoint) {
    acc = agg === 'max' ? -Infinity : 0;
    present = 0;
    forEachRun(index, g, g + perPoint, visit);
    // Buckets share one width, so the time-weighted mean is the plain mean of present buckets.
    if (present > 0) v[i] = agg === 'mean' ? acc / present : acc;
  }
  return { t, stepMs, v };
}

/**
 * Percentiles per point from the merged histogram of its buckets (exact merge). counts is the
 * number of samples per point: 0 for computed but empty points, NaN where no bucket exists.
 */
export function quantileSeries(
  index: SlotIndex<HistogramBlock>,
  metric: HistogramMetric,
  series: number,
  window: TimeWindow,
  columns: number,
  quantiles: readonly number[],
): QuantileData {
  const bucketMs = index.bucketMs;
  const { t0, n, stepMs } = chooseGrid(window, columns, bucketMs || FALLBACK_STEP_MS);
  const t = new Float64Array(n);
  const counts = new Float64Array(n).fill(NaN);
  const values = quantiles.map(() => new Float64Array(n).fill(NaN));
  for (let i = 0; i < n; i++) t[i] = t0 + i * stepMs;
  if (bucketMs === 0) return { t, stepMs, values, counts };

  const spec = HISTOGRAM_SPECS[metric];
  const bins = spec.bins;
  const scratch = new Uint32Array(bins);
  const perPoint = stepMs / bucketMs;
  let present = 0;
  const visit = (block: HistogramBlock | null, bucket: number, count: number) => {
    if (!block) {
      // Quiet buckets are computed and empty.
      present += count;
      return;
    }
    if (series < 0 || series >= block.series) return;
    const data = block.data[metric];
    let cell = bucket * block.series + series;
    for (let k = 0; k < count; k++, cell += block.series) {
      addSparseCellInto(scratch, 0, data, cell);
      present++;
    }
  };
  let g = t0 / bucketMs;
  for (let i = 0; i < n; i++, g += perPoint) {
    present = 0;
    scratch.fill(0);
    forEachRun(index, g, g + perPoint, visit);
    if (present === 0) continue;
    counts[i] = totalCount(scratch, 0, bins);
    for (let q = 0; q < quantiles.length; q++) {
      values[q]![i] = quantile(spec, scratch, 0, quantiles[q]!);
    }
  }
  return { t, stepMs, values, counts };
}
