// The fork cut rule (src/worker/protocol.ts header) as main-thread bookkeeping, and the test for
// whether data computed under an older revision is still valid.
//
// Why not drop every older-revision message? Worker messages are ordered, so everything the worker
// posted before it received a fork arrives before any message of the fork's revision. Some of that
// in-flight data is untouched by the fork: other days for a one-shot patch, earlier days for a
// lasting one, and the fork day before cutMs. The worker never resends it (it streams only from
// cutMs, and only recomputes the days the patch touches), so dropping it would leave permanent holes.
// Older-revision data is therefore dropped only where a newer fork invalidates it. Data straddling
// a cut is added and the cut re-applied; ordering guarantees no newer-revision data exists yet.

import { DAY_MS, WEEK_MS, type DayIndex, type SimMs } from '../engine/time.ts';
import type { ResultChunk } from '../engine/results.ts';
import type { ComputedRange } from '../worker/protocol.ts';
import { subtractRange } from './ranges.ts';

export interface CutRecord {
  revision: number;
  day: DayIndex;
  cutMs: SimMs;
  lasting: boolean;
}

export function cutMsFor(atMs: SimMs, histBucketMs: number): SimMs {
  return Math.floor(atMs / histBucketMs) * histBucketMs;
}

/** Removes the time a cut invalidates from computed ranges. */
export function applyCutToRanges(
  ranges: readonly ComputedRange[],
  cut: Pick<CutRecord, 'day' | 'cutMs' | 'lasting'>,
): ComputedRange[] {
  const until = cut.lasting ? WEEK_MS : (cut.day + 1) * DAY_MS;
  return subtractRange(ranges, cut.cutMs, until);
}

/** True when a newer cut invalidates all of `day` from `fromMs` on. */
function invalidates(cut: CutRecord, day: DayIndex, fromMs: SimMs): boolean {
  return (cut.lasting && day > cut.day) || (day === cut.day && fromMs >= cut.cutMs);
}

/** A rollup for `day` computed under `revision` is stale if any newer cut touches that day. */
export function dayInvalidated(
  cuts: readonly CutRecord[],
  revision: number,
  day: DayIndex,
): boolean {
  return cuts.some((c) => c.revision > revision && (day === c.day || (c.lasting && day > c.day)));
}

/** Earliest time any record in the chunk covers; complete buckets may start before fromMs. */
export function chunkDataStartMs(chunk: ResultChunk): SimMs {
  let t = chunk.fromMs;
  if (chunk.scalars.count > 0) t = Math.min(t, chunk.scalars.startMs);
  if (chunk.histograms.count > 0) t = Math.min(t, chunk.histograms.startMs);
  return t;
}

export type Verdict =
  | { action: 'drop' }
  /** Add the data, then re-apply these cuts (they straddle it). */
  | { action: 'add'; recut: CutRecord[] };

/** What to do with a chunk computed under `revision` when the store is at a later revision. */
export function classifyOlderChunk(
  cuts: readonly CutRecord[],
  revision: number,
  chunk: ResultChunk,
): Verdict {
  const newer = cuts.filter((c) => c.revision > revision);
  const fromMs = chunkDataStartMs(chunk);
  if (newer.some((c) => invalidates(c, chunk.day, fromMs))) return { action: 'drop' };
  return {
    action: 'add',
    recut: newer.filter((c) => c.day === chunk.day && chunk.toMs > c.cutMs),
  };
}
