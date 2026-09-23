// Fixed log-spaced latency histograms (02 §11, Theme 2 Q8). Shared by the engine (E9) and charts (U4).
// Bin i covers [min·r^i, min·r^(i+1)) with r = (max/min)^(1/bins). Values below min land in bin 0,
// values at or above max in the last bin. Merging is exact (add counts); percentiles interpolate
// geometrically within a bin. S1 may change the specs below; the layout functions stay.

export interface HistogramSpec {
  readonly minMs: number;
  readonly maxMs: number;
  readonly bins: number;
}

export const HISTOGRAM_SPECS = {
  ttft: { minMs: 1, maxMs: 1_000_000, bins: 96 },
  tpot: { minMs: 1, maxMs: 1_000, bins: 64 },
  e2e: { minMs: 1, maxMs: 2_000_000, bins: 96 },
} as const satisfies Record<string, HistogramSpec>;

export type HistogramMetric = keyof typeof HISTOGRAM_SPECS;
export const HISTOGRAM_METRICS = Object.keys(HISTOGRAM_SPECS) as HistogramMetric[];

function ratio(spec: HistogramSpec): number {
  return Math.pow(spec.maxMs / spec.minMs, 1 / spec.bins);
}

export function binIndex(spec: HistogramSpec, valueMs: number): number {
  if (!(valueMs > spec.minMs)) return 0;
  const i = Math.floor(Math.log(valueMs / spec.minMs) / Math.log(ratio(spec)));
  return i >= spec.bins ? spec.bins - 1 : i;
}

export function binLowerMs(spec: HistogramSpec, bin: number): number {
  return spec.minMs * Math.pow(ratio(spec), bin);
}

/** Adds `source` counts into `target` (same spec, same length, any offsets). */
export function mergeInto(
  target: Uint32Array,
  targetOffset: number,
  source: Uint32Array,
  sourceOffset: number,
  bins: number,
): void {
  for (let i = 0; i < bins; i++) target[targetOffset + i]! += source[sourceOffset + i]!;
}

export function totalCount(counts: Uint32Array, offset: number, bins: number): number {
  let n = 0;
  for (let i = 0; i < bins; i++) n += counts[offset + i]!;
  return n;
}

/**
 * The q-quantile (0 < q <= 1) of the histogram at counts[offset .. offset+bins), or NaN if empty.
 * Interpolates geometrically inside the bin that contains the target rank.
 */
export function quantile(
  spec: HistogramSpec,
  counts: Uint32Array,
  offset: number,
  q: number,
): number {
  const n = totalCount(counts, offset, spec.bins);
  if (n === 0) return NaN;
  const rank = q * n;
  let cumulative = 0;
  for (let i = 0; i < spec.bins; i++) {
    const c = counts[offset + i]!;
    if (c === 0) continue;
    if (cumulative + c >= rank) {
      const within = (rank - cumulative) / c;
      return binLowerMs(spec, i) * Math.pow(ratio(spec), within);
    }
    cumulative += c;
  }
  return binLowerMs(spec, spec.bins);
}
