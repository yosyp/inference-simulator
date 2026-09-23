// Sorted, trimmable views over a chunk's request and transition blocks. The typed arrays stay as
// delivered: a view holds only a permutation (null when the block is already in time order) and a
// kept count, so the fork cut trims by index range instead of copying or dropping whole chunks.

import type { ResultChunk } from '../../engine/results.ts';
import type { SimMs } from '../../engine/time.ts';

export interface SortedView {
  /** Block indices in key order, or null when the block is already sorted. NaN keys sort last. */
  readonly order: Uint32Array | null;
  /** Sorted positions [0, n) are kept. The fork cut lowers n. */
  n: number;
}

/** Block index at sorted position p. */
export function at(view: SortedView, p: number): number {
  return view.order === null ? p : view.order[p]!;
}

export function sortedView(key: Float64Array, count: number): SortedView {
  let sorted = true;
  let seenNaN = false;
  for (let i = 0; i < count; i++) {
    const k = key[i]!;
    if (Number.isNaN(k)) seenNaN = true;
    else if (seenNaN || (i > 0 && k < key[i - 1]!)) {
      sorted = false;
      break;
    }
  }
  if (sorted) return { order: null, n: count };
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => {
    const x = key[a]!;
    const y = key[b]!;
    if (Number.isNaN(x)) return Number.isNaN(y) ? a - b : 1;
    if (Number.isNaN(y)) return -1;
    return x - y || a - b;
  });
  return { order, n: count };
}

/** First sorted position in [lo, n) whose key is >= t. NaN keys count as +∞. */
export function lowerBound(key: Float64Array, view: SortedView, t: number, lo = 0): number {
  let hi = view.n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key[at(view, mid)]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One analyst's sorted positions in a source, built on demand for the tracked view. */
export interface AnalystPositions {
  readonly analyst: number;
  readonly req: Uint32Array;
  readonly tr: Uint32Array;
}

/**
 * A stored chunk. Requests are sorted by endMs and transitions by atMs. [fromMs, toMs) is the
 * range the chunk speaks for; the cut clamps toMs.
 */
export interface Source {
  readonly chunk: ResultChunk;
  readonly fromMs: SimMs;
  toMs: SimMs;
  readonly req: SortedView;
  readonly tr: SortedView;
  analyst: AnalystPositions | null;
}

export function makeSource(chunk: ResultChunk): Source {
  return {
    chunk,
    fromMs: chunk.fromMs,
    toMs: chunk.toMs,
    req: sortedView(chunk.requests.endMs, chunk.requests.count),
    tr: sortedView(chunk.transitions.atMs, chunk.transitions.count),
    analyst: null,
  };
}

/** The fork cut: drop records ending at or after cutMs and transitions at or after cutMs. */
export function trimSource(src: Source, cutMs: SimMs): void {
  src.req.n = lowerBound(src.chunk.requests.endMs, src.req, cutMs);
  src.tr.n = lowerBound(src.chunk.transitions.atMs, src.tr, cutMs);
  src.toMs = Math.min(src.toMs, cutMs);
}

/** True when the chunk holds every request's records and transitions, not only the tracked analyst's. */
export function isAllScope(chunk: ResultChunk): boolean {
  return chunk.requests.scope === 'all' && chunk.transitions.scope === 'all';
}

export function analystPositions(src: Source, analyst: number): AnalystPositions {
  if (src.analyst?.analyst === analyst) return src.analyst;
  const req: number[] = [];
  const tr: number[] = [];
  const ra = src.chunk.requests.analyst;
  const ta = src.chunk.transitions.analyst;
  for (let p = 0; p < src.req.n; p++) if (ra[at(src.req, p)] === analyst) req.push(p);
  for (let p = 0; p < src.tr.n; p++) if (ta[at(src.tr, p)] === analyst) tr.push(p);
  src.analyst = { analyst, req: Uint32Array.from(req), tr: Uint32Array.from(tr) };
  return src.analyst;
}

/** A piece of time [fromMs, toMs) whose records or transitions come from one source. */
export interface Piece {
  fromMs: SimMs;
  toMs: SimMs;
  src: Source;
}

/**
 * Splits [fromMs, toMs) among candidate sources: each claims the parts of its own range that no
 * earlier candidate claimed. Returns the claimed pieces in time order, so no record is counted twice.
 */
export function ownerPieces(fromMs: SimMs, toMs: SimMs, candidates: readonly Source[]): Piece[] {
  let gaps: number[] = fromMs < toMs ? [fromMs, toMs] : [];
  const pieces: Piece[] = [];
  for (const src of candidates) {
    if (gaps.length === 0) break;
    const next: number[] = [];
    for (let i = 0; i < gaps.length; i += 2) {
      const x = gaps[i]!;
      const y = gaps[i + 1]!;
      const lo = Math.max(x, src.fromMs);
      const hi = Math.min(y, src.toMs);
      if (lo < hi) {
        pieces.push({ fromMs: lo, toMs: hi, src });
        if (x < lo) next.push(x, lo);
        if (hi < y) next.push(hi, y);
      } else {
        next.push(x, y);
      }
    }
    gaps = next;
  }
  return pieces.sort((a, b) => a.fromMs - b.fromMs);
}

/** Sources in `sorted` (by fromMs, non-overlapping) whose range meets [fromMs, toMs). */
export function overlapping(sorted: readonly Source[], fromMs: SimMs, toMs: SimMs): Source[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.toMs <= fromMs) lo = mid + 1;
    else hi = mid;
  }
  const out: Source[] = [];
  for (let i = lo; i < sorted.length && sorted[i]!.fromMs < toMs; i++) {
    if (sorted[i]!.toMs > fromMs) out.push(sorted[i]!);
  }
  return out;
}
