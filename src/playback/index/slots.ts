// Per-day slot tables for scalar and histogram buckets: bucket start → block and offset. A series
// query then costs O(buckets in the window), however many chunks delivered them.
//
// The engine omits quiet buckets outside the day's active window (src/engine/metrics/quiet.ts), so
// a main chunk's block may cover less than the chunk. The chunk's other buckets are marked QUIET:
// computed, all zero except readyReplicas' fleet series (quietScalar), histograms empty. They are
// not gaps, and queries read them as those values.

import { DAY_MS, WEEK_DAYS, type DayIndex, type SimMs } from '../../engine/time.ts';

export interface BucketBlock {
  startMs: SimMs;
  bucketMs: number;
  count: number;
  series: number;
}

export interface SlotEntry<B extends BucketBlock> {
  readonly block: B;
  /** Day-local slot of the block's first bucket. */
  readonly startSlot: number;
}

/** Slot value of a computed bucket the engine omitted as quiet. -1 is a missing bucket. */
export const QUIET = -2;

/**
 * Global slot g covers [g × bucketMs, (g + 1) × bucketMs); day d holds slots
 * [d × slotsPerDay, (d + 1) × slotsPerDay). slots[d][local] is an index into entries[d], -1, or QUIET.
 */
export interface SlotIndex<B extends BucketBlock> {
  /** 0 until the first non-empty block arrives. */
  bucketMs: number;
  slotsPerDay: number;
  /** Series per bucket (replicas + 1), from the first block; 0 until then. */
  series: number;
  slots: (Int32Array | null)[];
  entries: SlotEntry<B>[][];
}

export function createSlotIndex<B extends BucketBlock>(): SlotIndex<B> {
  return {
    bucketMs: 0,
    slotsPerDay: 0,
    series: 0,
    slots: Array.from({ length: WEEK_DAYS }, () => null),
    entries: Array.from({ length: WEEK_DAYS }, () => []),
  };
}

/**
 * Adds a block. With `span` (a main chunk's [fromMs, toMs)), the chunk's buckets the block omits
 * are marked QUIET: those in [floor(fromMs), floor(toMs)) at this bucket width.
 */
export function addBlock<B extends BucketBlock>(
  index: SlotIndex<B>,
  day: DayIndex,
  block: B,
  span?: { fromMs: SimMs; toMs: SimMs },
): void {
  if (block.count === 0 && !(span && block.bucketMs > 0)) return;
  if (index.bucketMs === 0) {
    if (!(block.bucketMs > 0) || DAY_MS % block.bucketMs !== 0) {
      throw new Error(`Bucket width ${block.bucketMs} ms must divide a day`);
    }
    index.bucketMs = block.bucketMs;
    index.slotsPerDay = DAY_MS / block.bucketMs;
    index.series = block.series;
  } else if (block.bucketMs !== index.bucketMs) {
    throw new Error(`Bucket width changed from ${index.bucketMs} to ${block.bucketMs} ms`);
  }
  let slots = index.slots[day];
  if (!slots) {
    slots = new Int32Array(index.slotsPerDay).fill(-1);
    index.slots[day] = slots;
    index.entries[day] = [];
  }
  if (span) {
    const base = day * DAY_MS;
    const q0 = Math.max(0, Math.floor((span.fromMs - base) / index.bucketMs));
    const q1 = Math.min(index.slotsPerDay, Math.floor((span.toMs - base) / index.bucketMs));
    for (let i = q0; i < q1; i++) if (slots[i] === -1) slots[i] = QUIET;
  }
  if (block.count === 0) return;
  const entries = index.entries[day]!;
  const startSlot = Math.round((block.startMs - day * DAY_MS) / index.bucketMs);
  const lo = Math.max(0, startSlot);
  const hi = Math.min(index.slotsPerDay, startSlot + block.count);
  if (lo >= hi) return;
  entries.push({ block, startSlot });
  slots.fill(entries.length - 1, lo, hi);
}

/** The fork cut: forget buckets starting at or after cutMs, and blocks left with no buckets. */
export function cutSlots<B extends BucketBlock>(
  index: SlotIndex<B>,
  day: DayIndex,
  cutMs: SimMs,
): void {
  const slots = index.slots[day];
  if (!slots) return;
  const keep = Math.max(0, Math.ceil((cutMs - day * DAY_MS) / index.bucketMs));
  if (keep < slots.length) slots.fill(-1, keep);
  // Compact so dropped blocks can be collected.
  const old = index.entries[day]!;
  const remap = new Int32Array(old.length).fill(-1);
  const kept: SlotEntry<B>[] = [];
  for (let s = 0; s < slots.length; s++) {
    const id = slots[s]!;
    if (id < 0) continue;
    if (remap[id] === -1) {
      remap[id] = kept.length;
      kept.push(old[id]!);
    }
    slots[s] = remap[id]!;
  }
  index.entries[day] = kept;
}

export function dropSlotDay<B extends BucketBlock>(index: SlotIndex<B>, day: DayIndex): void {
  index.slots[day] = null;
  index.entries[day] = [];
}

/** True if global slot g is a QUIET bucket. */
export function isQuietAt<B extends BucketBlock>(index: SlotIndex<B>, g: number): boolean {
  if (index.slotsPerDay === 0) return false;
  const d = Math.floor(g / index.slotsPerDay);
  const slots = index.slots[d];
  return !!slots && slots[g - d * index.slotsPerDay] === QUIET;
}

/**
 * The entry holding global slot g, or undefined (missing or QUIET). Its bucket is
 * localSlot(index, g) - startSlot.
 */
export function entryAt<B extends BucketBlock>(
  index: SlotIndex<B>,
  g: number,
): SlotEntry<B> | undefined {
  if (index.slotsPerDay === 0) return undefined;
  const d = Math.floor(g / index.slotsPerDay);
  const slots = index.slots[d];
  if (!slots) return undefined;
  const id = slots[g - d * index.slotsPerDay]!;
  return id < 0 ? undefined : index.entries[d]![id];
}

/** Bucket offset of global slot g inside its entry's block. */
export function bucketIn<B extends BucketBlock>(
  index: SlotIndex<B>,
  entry: SlotEntry<B>,
  g: number,
): number {
  return g - Math.floor(g / index.slotsPerDay) * index.slotsPerDay - entry.startSlot;
}

/**
 * Calls visit(block, firstBucket, n) for each run of n consecutive present buckets of one block
 * among global slots [g0, g1), in time order; block is null for a run of QUIET buckets. Per-run
 * work (not per-bucket) keeps wide windows cheap.
 */
export function forEachRun<B extends BucketBlock>(
  index: SlotIndex<B>,
  g0: number,
  g1: number,
  visit: (block: B | null, firstBucket: number, n: number) => void,
): void {
  const spd = index.slotsPerDay;
  if (spd === 0) return;
  let g = g0;
  while (g < g1) {
    const d = Math.floor(g / spd);
    const base = d * spd;
    const dayEnd = Math.min(g1, base + spd);
    const slots = index.slots[d];
    if (slots) {
      const entries = index.entries[d]!;
      const end = dayEnd - base;
      let local = g - base;
      while (local < end) {
        const id = slots[local]!;
        let n = 1;
        while (local + n < end && slots[local + n] === id) n++;
        if (id >= 0) {
          const e = entries[id]!;
          visit(e.block, local - e.startSlot, n);
        } else if (id === QUIET) {
          visit(null, 0, n);
        }
        local += n;
      }
    }
    g = dayEnd;
  }
}
