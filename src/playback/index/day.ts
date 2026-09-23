// One day's stored chunks: main chunks from the worker's stream, detail windows, the tracked
// analyst's trace, and replica events. Days are independent (K21), so each is cut or dropped alone.

import type { ReplicaEvent, ResultChunk } from '../../engine/results.ts';
import type { DayIndex, SimMs } from '../../engine/time.ts';
import {
  appendSource,
  createDotStream,
  streamFromMs,
  streamToMs,
  truncateStream,
  type DotStream,
} from './dots.ts';
import { isAllScope, makeSource, overlapping, trimSource, type Source } from './sources.ts';

export interface DetailEntry {
  readonly src: Source;
  /** Null when the detail chunk is not scope 'all'. */
  stream: DotStream | null;
}

export interface DayData {
  readonly day: DayIndex;
  /** Main chunks, sorted by fromMs. */
  main: Source[];
  /** Contiguous runs of scope-'all' main chunks. */
  mainStreams: DotStream[];
  /** Detail windows in the order they arrived; later ones win where they overlap. */
  details: DetailEntry[];
  /** The latest trace; replaces tracked-scope records inside its range. */
  trace: Source | null;
  /** Sorted by atMs. */
  events: ReplicaEvent[];
}

export function createDay(day: DayIndex): DayData {
  return { day, main: [], mainStreams: [], details: [], trace: null, events: [] };
}

function rebuildMainStreams(dd: DayData): void {
  dd.mainStreams = [];
  let current: DotStream | null = null;
  for (const src of dd.main) {
    if (!isAllScope(src.chunk)) {
      current = null;
      continue;
    }
    if (!current || streamToMs(current) !== src.fromMs) {
      current = createDotStream();
      dd.mainStreams.push(current);
    }
    appendSource(current, src);
  }
}

export function addMainChunk(dd: DayData, chunk: ResultChunk): void {
  const src = makeSource(chunk);
  let i = dd.main.length;
  while (i > 0 && dd.main[i - 1]!.fromMs > src.fromMs) i--;
  dd.main.splice(i, 0, src);

  if (chunk.replicaEvents.length > 0) {
    const last = dd.events.length > 0 ? dd.events[dd.events.length - 1]! : null;
    dd.events.push(...chunk.replicaEvents);
    const inOrder = chunk.replicaEvents.every((e, j, a) => j === 0 || a[j - 1]!.atMs <= e.atMs);
    if (!inOrder || (last && last.atMs > chunk.replicaEvents[0]!.atMs)) {
      dd.events.sort((a, b) => a.atMs - b.atMs);
    }
  }

  if (!isAllScope(chunk)) return;
  if (i !== dd.main.length - 1) {
    // Arrived out of order: rare, so rebuild rather than splice into a stream.
    rebuildMainStreams(dd);
    return;
  }
  const stream = dd.mainStreams.length > 0 ? dd.mainStreams[dd.mainStreams.length - 1]! : null;
  const prev = i > 0 ? dd.main[i - 1]! : null;
  if (stream && prev && stream.sources[stream.sources.length - 1] === prev) {
    if (prev.toMs === src.fromMs) {
      appendSource(stream, src);
      return;
    }
  }
  const fresh = createDotStream();
  appendSource(fresh, src);
  dd.mainStreams.push(fresh);
}

export function addDetailChunk(dd: DayData, chunk: ResultChunk): DetailEntry {
  const src = makeSource(chunk);
  let stream: DotStream | null = null;
  if (isAllScope(chunk)) {
    stream = createDotStream();
    appendSource(stream, src);
  }
  const entry = { src, stream };
  dd.details.push(entry);
  return entry;
}

export function setTrace(dd: DayData, chunk: ResultChunk): void {
  dd.trace = makeSource(chunk);
}

/** The fork cut rule (src/worker/protocol.ts) on this day's records, transitions, and events. */
export function cutDay(dd: DayData, cutMs: SimMs): void {
  dd.main = dd.main.filter((s) => s.fromMs < cutMs);
  for (const s of dd.main) trimSource(s, cutMs);
  dd.mainStreams = dd.mainStreams.filter((s) => truncateStream(s, cutMs));

  dd.details = dd.details.filter((e) => e.src.fromMs < cutMs);
  for (const e of dd.details) {
    trimSource(e.src, cutMs);
    if (e.stream && !truncateStream(e.stream, cutMs)) e.stream = null;
  }

  if (dd.trace && dd.trace.fromMs >= cutMs) dd.trace = null;
  if (dd.trace) trimSource(dd.trace, cutMs);

  dd.events = dd.events.filter((e) => e.atMs < cutMs);
}

/** The dot stream whose scope-'all' transitions cover t: main chunks first, then the latest detail. */
export function dotStreamAt(dd: DayData, t: SimMs): DotStream | null {
  for (const s of dd.mainStreams) if (streamFromMs(s) <= t && t < streamToMs(s)) return s;
  for (let i = dd.details.length - 1; i >= 0; i--) {
    const e = dd.details[i]!;
    if (e.stream && e.src.fromMs <= t && t < e.src.toMs) return e.stream;
  }
  return null;
}

/**
 * Who speaks for records ending in [fromMs, toMs): scope-'all' main chunks, then scope-'all'
 * detail windows (latest first), then the trace, then tracked-scope main chunks. Pass the result
 * to ownerPieces so no record is counted twice.
 */
export function recordSources(dd: DayData, fromMs: SimMs, toMs: SimMs): Source[] {
  const near = overlapping(dd.main, fromMs, toMs);
  const out = near.filter((s) => s.chunk.requests.scope === 'all');
  for (let i = dd.details.length - 1; i >= 0; i--) {
    const s = dd.details[i]!.src;
    if (s.chunk.requests.scope === 'all' && s.fromMs < toMs && s.toMs > fromMs) out.push(s);
  }
  if (dd.trace) out.push(dd.trace);
  for (const s of near) if (s.chunk.requests.scope === 'tracked') out.push(s);
  return out;
}

/**
 * Sources of the tracked analyst's data in priority order: the trace, then every main chunk.
 * Scope-'all' main chunks count too (filtered by analyst), for runs that record every request and
 * so emit no separate tracked block.
 */
export function trackedSources(dd: DayData): Source[] {
  return dd.trace ? [dd.trace, ...dd.main] : dd.main;
}
