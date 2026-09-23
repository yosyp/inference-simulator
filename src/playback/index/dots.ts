// Canvas dots from scope-'all' transitions (05 §7). A dot stream is a contiguous run of sources in
// time order. Each transition opens a segment: the request holds that state from the transition's
// time until its next transition, or until its record's endMs when the engine emits no terminal
// transition. Snapshots of the open segments every SNAPSHOT_EVERY transitions make a query cost
// O(open requests + transitions since the snapshot), independent of how far into the day it is.

import { REQUEST_STATE, type TransitionBlock } from '../../engine/results.ts';
import type { SimMs } from '../../engine/time.ts';
import { at, type Source } from './sources.ts';

const SNAPSHOT_EVERY = 1024;
const FIRST_TERMINAL: number = REQUEST_STATE.finished;

interface Snapshot {
  /** Segments [0, pos) are accounted for. */
  pos: number;
  /** Start of segment pos - 1; valid for queries at or after it. */
  atMs: SimMs;
  /** Segments below pos that might still be open at atMs (a superset; queries filter by end). */
  open: Int32Array;
}

export interface DotStream {
  sources: Source[];
  /** Global index of each source's first segment. */
  base: number[];
  /** Transitions each source contributed. */
  len: number[];
  total: number;
  /** End of each segment; +∞ while unknown. A terminal state's segment ends where it starts. */
  end: Float64Array;
  /** Request → its last segment, while that segment's end is unknown. */
  open: Map<number, number>;
  snaps: Snapshot[];
  sinceSnap: number;
}

export function createDotStream(): DotStream {
  return {
    sources: [],
    base: [],
    len: [],
    total: 0,
    end: new Float64Array(256),
    open: new Map(),
    snaps: [],
    sinceSnap: 0,
  };
}

export function streamFromMs(s: DotStream): SimMs {
  return s.sources.length > 0 ? s.sources[0]!.fromMs : Infinity;
}

export function streamToMs(s: DotStream): SimMs {
  return s.sources.length > 0 ? s.sources[s.sources.length - 1]!.toMs : -Infinity;
}

function snapshot(s: DotStream, atMs: SimMs): void {
  const prev = s.snaps.length > 0 ? s.snaps[s.snaps.length - 1]! : null;
  const out: number[] = [];
  if (prev) for (const g of prev.open) if (s.end[g]! > atMs) out.push(g);
  for (let g = prev ? prev.pos : 0; g < s.total; g++) if (s.end[g]! > atMs) out.push(g);
  s.snaps.push({ pos: s.total, atMs, open: Int32Array.from(out) });
  s.sinceSnap = 0;
}

/** Appends the next source in time order: its transitions, then its records' end times. */
export function appendSource(s: DotStream, src: Source): void {
  const tb = src.chunk.transitions;
  const n = src.tr.n;
  if (s.total + n > s.end.length) {
    const grown = new Float64Array(Math.max(s.total + n, s.end.length * 2));
    grown.set(s.end.subarray(0, s.total));
    s.end = grown;
  }
  s.base.push(s.total);
  s.len.push(n);
  s.sources.push(src);
  const { end, open } = s;
  for (let p = 0; p < n; p++) {
    const k = at(src.tr, p);
    const g = s.total++;
    const t = tb.atMs[k]!;
    const request = tb.request[k]!;
    const prev = open.get(request);
    if (prev !== undefined) end[prev] = t;
    if (tb.state[k]! >= FIRST_TERMINAL) {
      end[g] = t;
      open.delete(request);
    } else {
      end[g] = Infinity;
      open.set(request, g);
    }
    if (++s.sinceSnap >= SNAPSHOT_EVERY) snapshot(s, t);
  }
  const rb = src.chunk.requests;
  for (let p = 0; p < src.req.n; p++) {
    const k = at(src.req, p);
    const request = rb.id[k]!;
    const prev = open.get(request);
    const endMs = rb.endMs[k]!;
    if (prev === undefined || !Number.isFinite(endMs)) continue;
    end[prev] = endMs;
    open.delete(request);
  }
}

function rebuild(s: DotStream, sources: readonly Source[]): void {
  Object.assign(s, createDotStream());
  for (const src of sources) appendSource(s, src);
}

/**
 * The fork cut, after the caller trimmed the sources with trimSource. Segments closed by discarded
 * data reopen. Returns false when nothing is left.
 */
export function truncateStream(s: DotStream, cutMs: SimMs): boolean {
  let keep = 0;
  while (keep < s.sources.length && s.sources[keep]!.fromMs < cutMs) keep++;
  if (keep === 0) return false;
  for (let i = 0; i < keep - 1; i++) {
    if (s.sources[i]!.tr.n !== s.len[i]) {
      rebuild(s, s.sources.slice(0, keep));
      return true;
    }
  }
  const last = keep - 1;
  const total = s.base[last]! + s.sources[last]!.tr.n;
  s.sources.length = keep;
  s.base.length = keep;
  s.len.length = keep;
  s.len[last] = s.sources[last]!.tr.n;
  s.total = total;
  const end = s.end;
  for (let g = 0; g < total; g++) if (end[g]! >= cutMs) end[g] = Infinity;
  // Each request has at most one open segment left: its last kept one.
  s.open = new Map();
  for (let i = 0; i < keep; i++) {
    const src = s.sources[i]!;
    const request = src.chunk.transitions.request;
    for (let p = 0; p < s.len[i]!; p++) {
      const g = s.base[i]! + p;
      if (end[g] === Infinity) s.open.set(request[at(src.tr, p)]!, g);
    }
  }
  s.snaps = s.snaps.filter((snap) => snap.pos <= total);
  s.sinceSnap = total - (s.snaps.length > 0 ? s.snaps[s.snaps.length - 1]!.pos : 0);
  return true;
}

/** Index of the source holding segment g (g < total). */
function sourceOf(s: DotStream, g: number): number {
  let lo = 0;
  let hi = s.base.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (s.base[mid]! <= g) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function progress(startMs: number, endMs: number, t: number): number {
  if (!(endMs < Infinity) || !(endMs > startMs)) return 0;
  return Math.min(1, Math.max(0, (t - startMs) / (endMs - startMs)));
}

export type DotVisitor = (tb: TransitionBlock, k: number, progress: number) => void;

/** Visits each request in a non-terminal state at t: its last transition at or before t. */
export function activeAt(s: DotStream, t: SimMs, visit: DotVisitor): void {
  let lo = 0;
  let hi = s.snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (s.snaps[mid]!.atMs <= t) lo = mid + 1;
    else hi = mid;
  }
  const snap = lo > 0 ? s.snaps[lo - 1]! : null;
  const end = s.end;
  if (snap) {
    for (const g of snap.open) {
      if (!(end[g]! > t)) continue;
      const i = sourceOf(s, g);
      const src = s.sources[i]!;
      const k = at(src.tr, g - s.base[i]!);
      visit(src.chunk.transitions, k, progress(src.chunk.transitions.atMs[k]!, end[g]!, t));
    }
  }
  let g = snap ? snap.pos : 0;
  if (g >= s.total) return;
  let i = sourceOf(s, g);
  while (g < s.total) {
    while (g >= s.base[i]! + s.len[i]!) i++;
    const src = s.sources[i]!;
    const tb = src.chunk.transitions;
    const k = at(src.tr, g - s.base[i]!);
    const startMs = tb.atMs[k]!;
    if (startMs > t) break;
    if (end[g]! > t) visit(tb, k, progress(startMs, end[g]!, t));
    g++;
  }
}
