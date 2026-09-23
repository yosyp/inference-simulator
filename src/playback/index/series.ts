// Chart series (05 §6): at most one point per pixel column, each point aggregating whole buckets.
// Scalars use their metric's aggregation kind; percentiles come from exactly merged histograms.

import {
  HISTOGRAM_SPECS,
  mergeInto,
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
  const visit = (block: ScalarBlock, bucket: number, count: number) => {
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
  let first: Uint32Array = scratch;
  let firstOffset = 0;
  const visit = (block: HistogramBlock, bucket: number, count: number) => {
    if (series < 0 || series >= block.series) return;
    const data = block.data[metric];
    const stride = block.series * bins;
    let offset = (bucket * block.series + series) * bins;
    for (let k = 0; k < count; k++, offset += stride) {
      if (present === 0) {
        first = data;
        firstOffset = offset;
      } else {
        if (present === 1) for (let b = 0; b < bins; b++) scratch[b] = first[firstOffset + b]!;
        mergeInto(scratch, 0, data, offset, bins);
      }
      present++;
    }
  };
  let g = t0 / bucketMs;
  for (let i = 0; i < n; i++, g += perPoint) {
    present = 0;
    forEachRun(index, g, g + perPoint, visit);
    if (present === 0) continue;
    // A single bucket is read in place; only merges use the scratch histogram.
    const hist = present === 1 ? first : scratch;
    const offset = present === 1 ? firstOffset : 0;
    counts[i] = totalCount(hist, offset, bins);
    for (let q = 0; q < quantiles.length; q++) {
      values[q]![i] = quantile(spec, hist, offset, quantiles[q]!);
    }
  }
  return { t, stepMs, values, counts };
}
