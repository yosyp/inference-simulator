// Per-day slot tables for scalar and histogram buckets: bucket start → block and offset. A series
// query then costs O(buckets in the window), however many chunks delivered them.

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

/**
 * Global slot g covers [g × bucketMs, (g + 1) × bucketMs); day d holds slots
 * [d × slotsPerDay, (d + 1) × slotsPerDay). slots[d][local] is an index into entries[d], or -1.
 */
export interface SlotIndex<B extends BucketBlock> {
  /** 0 until the first non-empty block arrives. */
  bucketMs: number;
  slotsPerDay: number;
  slots: (Int32Array | null)[];
  entries: SlotEntry<B>[][];
}

export function createSlotIndex<B extends BucketBlock>(): SlotIndex<B> {
  return {
    bucketMs: 0,
    slotsPerDay: 0,
    slots: Array.from({ length: WEEK_DAYS }, () => null),
    entries: Array.from({ length: WEEK_DAYS }, () => []),
  };
}

export function addBlock<B extends BucketBlock>(
  index: SlotIndex<B>,
  day: DayIndex,
  block: B,
): void {
  if (block.count === 0) return;
  if (index.bucketMs === 0) {
    if (!(block.bucketMs > 0) || DAY_MS % block.bucketMs !== 0) {
      throw new Error(`Bucket width ${block.bucketMs} ms must divide a day`);
    }
    index.bucketMs = block.bucketMs;
    index.slotsPerDay = DAY_MS / block.bucketMs;
  } else if (block.bucketMs !== index.bucketMs) {
    throw new Error(`Bucket width changed from ${index.bucketMs} to ${block.bucketMs} ms`);
  }
  let slots = index.slots[day];
  if (!slots) {
    slots = new Int32Array(index.slotsPerDay).fill(-1);
    index.slots[day] = slots;
    index.entries[day] = [];
  }
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

/** The entry holding global slot g, or undefined. Its bucket is localSlot(index, g) - startSlot. */
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
 * among global slots [g0, g1), in time order. Per-run work (not per-bucket) keeps wide windows cheap.
 */
export function forEachRun<B extends BucketBlock>(
  index: SlotIndex<B>,
  g0: number,
  g1: number,
  visit: (block: B, firstBucket: number, n: number) => void,
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
        }
        local += n;
      }
    }
    g = dayEnd;
  }
}
