// Growable columnar buffers for what the slice holds until produceChunk: completed scalar and
// histogram buckets, request records, and transitions. Each has a `count` of rows (or buckets) in
// use and arrays sized for capacity, doubling as needed. Scalars, records, and transitions are
// contract blocks (results.ts); histograms stay dense until emitted, then become sparse (K29).
// Emitting copies the used rows into exact-size arrays, so every array in a chunk owns its buffer.

import { HISTOGRAM_METRICS, HISTOGRAM_SPECS, type HistogramMetric } from '../histogram.ts';
import {
  SCALAR_METRIC_NAMES,
  allocDenseHistograms,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  histogramBlockFromDense,
  type HistogramBlock,
  type RequestBlock,
  type ScalarBlock,
  type TransitionBlock,
} from '../results.ts';
import type { PendingHists } from './slice.ts';

type Column = Uint8Array | Int8Array | Uint16Array | Uint32Array | Float32Array | Float64Array;

const MIN_ROWS = 16;

function nextCapacity(have: number, need: number): number {
  let cap = Math.max(MIN_ROWS, have);
  while (cap < need) cap *= 2;
  return cap;
}

/** Copies rows [0, rows) of every column (typed-array field, one element per row). */
function copyRows<T extends object>(from: T, to: T, rows: number): void {
  for (const key of Object.keys(from) as (keyof T)[]) {
    const src = from[key];
    if (ArrayBuffer.isView(src)) {
      (to[key] as unknown as Column).set((src as unknown as Column).subarray(0, rows) as never);
    }
  }
}

// Scalar and histogram buckets.

export function scalarCapacity(b: ScalarBlock): number {
  return b.data.kvUsedFrac.length / b.series;
}

/** Makes room for one more scalar bucket and returns its offset (bucket × series). */
export function pushScalarBucket(holder: { scalars: ScalarBlock }): number {
  const b = holder.scalars;
  if (b.count === scalarCapacity(b)) {
    const grown = allocScalarBlock(
      b.startMs,
      b.bucketMs,
      nextCapacity(b.count, b.count + 1),
      b.series,
    );
    for (const m of SCALAR_METRIC_NAMES) grown.data[m].set(b.data[m]);
    grown.count = b.count;
    holder.scalars = grown;
  }
  const s = holder.scalars;
  return s.count++ * s.series;
}

export function histCapacity(h: PendingHists): number {
  return h.dense.ttft.length / (h.series * HISTOGRAM_SPECS.ttft.bins);
}

/** Appends one histogram bucket copied from `open` (dense, one bucket). */
export function pushHistBucket(
  holder: { hists: PendingHists },
  open: Record<HistogramMetric, Uint32Array>,
): void {
  const h = holder.hists;
  if (h.count === histCapacity(h)) {
    const grown = allocDenseHistograms(nextCapacity(h.count, h.count + 1), h.series);
    for (const m of HISTOGRAM_METRICS) grown[m].set(h.dense[m]);
    h.dense = grown;
  }
  for (const m of HISTOGRAM_METRICS) h.dense[m].set(open[m], h.count * open[m].length);
  h.count++;
}

/** The first `count` pending buckets (default all), in an exact-size block. */
export function exactScalars(b: ScalarBlock, count = b.count): ScalarBlock {
  const out = allocScalarBlock(b.startMs, b.bucketMs, count, b.series);
  const n = count * b.series;
  for (const m of SCALAR_METRIC_NAMES) out.data[m].set(b.data[m].subarray(0, n));
  return out;
}

/** The first `count` pending buckets (default all) as a sparse block (K29). */
export function sparseHists(
  h: PendingHists,
  histBucketMs: number,
  count = h.count,
): HistogramBlock {
  return histogramBlockFromDense(h.startMs, histBucketMs, count, h.series, h.dense);
}

// Request records and transitions.

/** Makes room for one more request record and returns its row. */
export function pushRequestRow(holder: { requests: RequestBlock }): number {
  const b = holder.requests;
  if (b.count === b.id.length) {
    const grown = allocRequestBlock(b.scope, nextCapacity(b.count, b.count + 1));
    copyRows(b, grown, b.count);
    grown.count = b.count;
    holder.requests = grown;
  }
  return holder.requests.count++;
}

/** Makes room for one more transition and returns its row. */
export function pushTransitionRow(holder: { transitions: TransitionBlock }): number {
  const b = holder.transitions;
  if (b.count === b.atMs.length) {
    const grown = allocTransitionBlock(b.scope, nextCapacity(b.count, b.count + 1));
    copyRows(b, grown, b.count);
    grown.count = b.count;
    holder.transitions = grown;
  }
  return holder.transitions.count++;
}

/**
 * Opens a transition row at `row`, shifting rows [row, count) down by one. Returns `row`. Used when
 * a request's arrival row must precede an end row written during a nested notice.
 */
export function insertTransitionRow(holder: { transitions: TransitionBlock }, row: number): number {
  const last = pushTransitionRow(holder);
  const b = holder.transitions;
  if (row < last) {
    for (const col of [b.atMs, b.request, b.analyst, b.replica, b.state] as Column[]) {
      col.copyWithin(row + 1, row, last);
    }
  }
  return row;
}

export function exactRequests(b: RequestBlock, scope: 'all' | 'tracked'): RequestBlock {
  const out = allocRequestBlock(scope, b.count);
  copyRows(b, out, b.count);
  return out;
}

export function exactTransitions(b: TransitionBlock, scope: 'all' | 'tracked'): TransitionBlock {
  const out = allocTransitionBlock(scope, b.count);
  copyRows(b, out, b.count);
  return out;
}
