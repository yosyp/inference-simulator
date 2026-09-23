// Building the chunks the host posts besides the main stream: detail windows (records and
// transitions only) and traces (a tracked analyst's whole day). Scalars and histograms are left
// empty: the results index reads those only from main chunks.

import type { SimConfig } from '../engine/api.ts';
import {
  allocHistogramBlock,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  type ReplicaEvent,
  type RequestBlock,
  type ResultChunk,
  type TransitionBlock,
} from '../engine/results.ts';
import type { DayIndex, SimMs } from '../engine/time.ts';

type Scope = 'all' | 'tracked';

type Column = { length: number; [i: number]: number };

/** Rows of `blocks` in order whose key is below limitMs, as one exact-size block. */
function concat<T extends RequestBlock | TransitionBlock>(
  blocks: readonly T[],
  alloc: (n: number) => T,
  key: (b: T) => Float64Array,
  limitMs: SimMs,
): T {
  const rows = blocks.map((b) => {
    const k = key(b);
    const keep: number[] = [];
    for (let i = 0; i < b.count; i++) if (k[i]! < limitMs) keep.push(i);
    return keep;
  });
  const out = alloc(rows.reduce((n, r) => n + r.length, 0));
  const columns = Object.keys(out).filter((c) => ArrayBuffer.isView(out[c as keyof T]));
  let base = 0;
  blocks.forEach((b, j) => {
    const keep = rows[j]!;
    for (const c of columns) {
      const src = b[c as keyof T] as unknown as Column;
      const dst = out[c as keyof T] as unknown as Column;
      for (let i = 0; i < keep.length; i++) dst[base + i] = src[keep[i]!]!;
    }
    base += keep.length;
  });
  return out;
}

export function concatRequests(
  blocks: readonly RequestBlock[],
  scope: Scope,
  limitMs: SimMs = Infinity,
): RequestBlock {
  return concat(
    blocks,
    (n) => allocRequestBlock(scope, n),
    (b) => b.endMs,
    limitMs,
  );
}

export function concatTransitions(
  blocks: readonly TransitionBlock[],
  scope: Scope,
  limitMs: SimMs = Infinity,
): TransitionBlock {
  return concat(
    blocks,
    (n) => allocTransitionBlock(scope, n),
    (b) => b.atMs,
    limitMs,
  );
}

/** A chunk carrying only records, transitions, and replica events for [fromMs, toMs). */
export function recordsChunk(
  config: SimConfig,
  day: DayIndex,
  fromMs: SimMs,
  toMs: SimMs,
  requests: RequestBlock,
  transitions: TransitionBlock,
  replicaEvents: ReplicaEvent[] = [],
): ResultChunk {
  const series = config.replicas + 1;
  return {
    day,
    fromMs,
    toMs,
    replicas: config.replicas,
    scalars: allocScalarBlock(fromMs, config.bucketMs, 0, series),
    histograms: allocHistogramBlock(fromMs, config.histBucketMs, 0, series),
    requests,
    transitions,
    replicaEvents,
  };
}

/** An empty chunk with tracked scope: the results index stores it but reads nothing from it. */
export function inertChunk(
  config: SimConfig,
  day: DayIndex,
  fromMs: SimMs,
  toMs: SimMs,
): ResultChunk {
  return recordsChunk(
    config,
    day,
    fromMs,
    toMs,
    allocRequestBlock('tracked', 0),
    allocTransitionBlock('tracked', 0),
  );
}
