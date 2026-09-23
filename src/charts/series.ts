// Array helpers shared by the panel builders: clipping at the playhead, per-bucket arithmetic,
// window statistics, the worst-replica pick, y axes, and per-column decimation.

import { max as d3Max } from 'd3-array';
import { scaleLinear } from 'd3-scale';
import type { SimMs } from '../engine/time.ts';
import type { SeriesData } from '../playback/types.ts';
import type { AxisTick } from './panel-types.ts';

/** The complete buckets of a series by visibleToMs (t[i] + stepMs <= visibleToMs), as views. */
export function clipComplete(
  t: Float64Array,
  v: Float64Array,
  stepMs: number,
  visibleToMs: SimMs,
): { t: Float64Array; v: Float64Array } {
  const n = completeCount(t, stepMs, visibleToMs);
  return { t: t.subarray(0, n), v: v.subarray(0, n) };
}

/** How many leading buckets end at or before visibleToMs (t is ascending). */
export function completeCount(t: Float64Array, stepMs: number, visibleToMs: SimMs): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! + stepMs <= visibleToMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** a[i] ÷ b[i]; NaN where b[i] is 0 or either side is missing. */
export function divide(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const d = b[i]!;
    out[i] = d > 0 && Number.isFinite(d) ? a[i]! / d : NaN;
  }
  return out;
}

/** a[i] × k. */
export function scaleBy(a: Float64Array, k: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! * k;
  return out;
}

/** a[i] + b[i]. */
export function add(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
  return out;
}

/** A 'sum' series (events per bucket) as a rate per second. */
export function perSecond(s: SeriesData): Float64Array {
  return scaleBy(s.v, 1000 / s.stepMs);
}

/** Mean of the finite values; NaN if there are none. */
export function finiteMean(v: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (Number.isFinite(x)) {
      sum += x;
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

/** Sum of the finite values. */
export function finiteSum(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (Number.isFinite(x)) sum += x;
  }
  return sum;
}

/** Largest finite value, or NaN. */
export function finiteMax(v: ArrayLike<number>): number {
  const m = d3Max(Array.from(v).filter(Number.isFinite));
  return m ?? NaN;
}

/** The last finite value, or NaN. */
export function lastFinite(v: ArrayLike<number>): number {
  for (let i = v.length - 1; i >= 0; i--) if (Number.isFinite(v[i]!)) return v[i]!;
  return NaN;
}

/** Index of the largest finite score, lowest index on ties; null when none is finite. */
export function pickWorst(scores: readonly number[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (Number.isFinite(s) && (best === null || s > scores[best]!)) best = i;
  }
  return best;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A y axis from 0 to a nice value at or above `max` (at least `floor`), with about three ticks.
 * Legible at the 132 px chart height.
 */
export function zeroBasedAxis(
  max: number,
  floor: number,
  format: (ticks: readonly number[]) => (v: number) => string,
): { domain: [number, number]; ticks: AxisTick[] } {
  const top = Number.isFinite(max) ? Math.max(max, floor) : floor;
  const scale = scaleLinear().domain([0, top]).nice(3);
  const values = scale.ticks(3);
  const fmt = format(values);
  const [, hi] = scale.domain() as [number, number];
  return { domain: [0, hi], ticks: values.map((value) => ({ value, label: fmt(value) })) };
}

/**
 * A log axis for latency: whole decades around the finite positive values, at least two decades
 * tall and never below 1 ms (the histogram floor), with a tick per decade ("10 ms", "1 s").
 */
export function logMsAxis(values: readonly number[]): {
  domain: [number, number];
  ticks: AxisTick[];
} {
  const pos = values.filter((v) => Number.isFinite(v) && v > 0);
  const lo0 = pos.length > 0 ? Math.min(...pos) : 10;
  const hi0 = pos.length > 0 ? Math.max(...pos) : 1000;
  let hi = Math.pow(10, Math.ceil(Math.log10(hi0)));
  let lo = Math.pow(10, Math.floor(Math.log10(lo0)));
  if (hi <= lo) hi = lo * 10;
  lo = Math.max(1, Math.min(lo, hi / 100));
  if (hi / lo < 100) hi = lo * 100;
  const decades: number[] = [];
  for (let v = lo; v <= hi * 1.0001; v *= 10) decades.push(Math.round(v));
  const every = decades.length > 5 ? 2 : 1;
  const ticks = decades
    .filter((_, i) => (decades.length - 1 - i) % every === 0)
    .map((value) => ({ value, label: logMsLabel(value) }));
  return { domain: [lo, hi], ticks };
}

function logMsLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${ms / 1000} s`;
}

/** Largest finite value across several arrays, or NaN. */
export function maxOf(arrays: readonly ArrayLike<number>[]): number {
  let m = NaN;
  for (const a of arrays) {
    const x = finiteMax(a);
    if (Number.isFinite(x) && !(x <= m)) m = x;
  }
  return m;
}

/** A fixed 0..1 axis with ticks at 0, 50%, and 100%. */
export function unitAxis(format: (v: number) => string): {
  domain: [number, number];
  ticks: AxisTick[];
} {
  return { domain: [0, 1], ticks: [0, 0.5, 1].map((value) => ({ value, label: format(value) })) };
}

/**
 * Keeps at most one point per pixel column: the largest value in each column, so tail latency is
 * never hidden. `toPx` maps a time to its x pixel. Input must be sorted by time.
 */
export function decimatePerColumn(
  t: ArrayLike<number>,
  v: ArrayLike<number>,
  toPx: (ms: number) => number,
): { t: Float64Array; v: Float64Array } {
  const outT: number[] = [];
  const outV: number[] = [];
  let lastCol = NaN;
  for (let i = 0; i < t.length; i++) {
    const val = v[i]!;
    if (!Number.isFinite(val)) continue;
    const col = Math.floor(toPx(t[i]!));
    if (col === lastCol) {
      if (val > outV[outV.length - 1]!) {
        outV[outV.length - 1] = val;
        outT[outT.length - 1] = t[i]!;
      }
      continue;
    }
    lastCol = col;
    outT.push(t[i]!);
    outV.push(val);
  }
  return { t: Float64Array.from(outT), v: Float64Array.from(outV) };
}

/** The value of the bucket containing ms, or NaN. */
export function valueAt(t: Float64Array, v: Float64Array, stepMs: number, ms: SimMs): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms < t[mid]!) hi = mid - 1;
    else if (ms >= t[mid]! + stepMs) lo = mid + 1;
    else return v[mid]!;
  }
  return NaN;
}

/** Index of the point nearest to ms within maxDistMs, or -1. */
export function nearestIndex(t: Float64Array, ms: SimMs, maxDistMs: number): number {
  let best = -1;
  let bestD = maxDistMs;
  for (let i = 0; i < t.length; i++) {
    const d = Math.abs(t[i]! - ms);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}
