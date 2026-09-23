// Fixed log-spaced latency histograms (02 §11, Theme 2 Q8). Shared by the engine (E9) and the results
// index (U8). Bin i covers [min·r^i, min·r^(i+1)) with r = (max/min)^(1/bins). Values below min land in
// bin 0, values at or above max in the last bin. Merging is exact (add counts); percentiles interpolate
// geometrically within a bin.
//
// Storage (K29): emitted histograms are sparse (CSR). Builders accumulate dense counts for the buckets
// they have open, then convert with sparseFromDense; readers merge cells into a dense scratch array
// with addSparseCellInto, then call quantile on it.

export interface HistogramSpec {
  readonly minMs: number;
  readonly maxMs: number;
  readonly bins: number;
}

/** Bin ratio ≈ 1.075 (K29): p99 error ≈ 1% typical, up to ~7% in a busy minute (S1). */
export const HISTOGRAM_SPECS = {
  ttft: { minMs: 1, maxMs: 1_000_000, bins: 192 },
  tpot: { minMs: 1, maxMs: 1_000, bins: 128 },
  e2e: { minMs: 1, maxMs: 2_000_000, bins: 192 },
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

/**
 * Sparse histograms for `cells` cells (cell = bucket × series + seriesIndex). Cell i's nonzero bins
 * are bins[offsets[i] .. offsets[i+1]) with their counts, bins ascending. offsets has cells + 1 entries.
 */
export interface SparseHistograms {
  offsets: Uint32Array;
  bins: Uint16Array;
  counts: Uint32Array;
}

export function emptySparse(cells: number): SparseHistograms {
  return {
    offsets: new Uint32Array(cells + 1),
    bins: new Uint16Array(0),
    counts: new Uint32Array(0),
  };
}

/** Converts dense counts (cells × bins, cell-major) to sparse form. */
export function sparseFromDense(dense: Uint32Array, cells: number, bins: number): SparseHistograms {
  let nnz = 0;
  for (let i = 0; i < cells * bins; i++) if (dense[i]! !== 0) nnz++;
  const out: SparseHistograms = {
    offsets: new Uint32Array(cells + 1),
    bins: new Uint16Array(nnz),
    counts: new Uint32Array(nnz),
  };
  let k = 0;
  for (let c = 0; c < cells; c++) {
    out.offsets[c] = k;
    const base = c * bins;
    for (let b = 0; b < bins; b++) {
      const n = dense[base + b]!;
      if (n !== 0) {
        out.bins[k] = b;
        out.counts[k] = n;
        k++;
      }
    }
  }
  out.offsets[cells] = k;
  return out;
}

/** Adds one sparse cell's counts into a dense histogram at target[targetOffset .. + bins). */
export function addSparseCellInto(
  target: Uint32Array,
  targetOffset: number,
  sparse: SparseHistograms,
  cell: number,
): void {
  const end = sparse.offsets[cell + 1]!;
  for (let k = sparse.offsets[cell]!; k < end; k++) {
    target[targetOffset + sparse.bins[k]!]! += sparse.counts[k]!;
  }
}

export function sparseCellCount(sparse: SparseHistograms, cell: number): number {
  let n = 0;
  const end = sparse.offsets[cell + 1]!;
  for (let k = sparse.offsets[cell]!; k < end; k++) n += sparse.counts[k]!;
  return n;
}
