// KV block pool state (02 §7 rules 3 and 5; mirrors vLLM V1's BlockPool with automatic prefix
// caching). Plain data only (typed arrays, a Map, numbers) so structuredClone checkpoints work.
//
// Every block is in exactly one of three states:
// - free: refCount 0 and no content key. Kept on a stack; allocation takes these first.
// - referenced: refCount > 0. Held by one or more requests; may or may not have a content key.
// - evictable: refCount 0 with a content key. Still findable by prefix lookup; kept on an LRU list
//   and reused (evicted) only when no free block is left, least recently released first.
//
// The LRU is an intrusive doubly linked list in two Int32Arrays of length totalBlocks + 1, where
// index totalBlocks is a sentinel: lruNext[sentinel] is the least recently used block (evicted
// next) and lruPrev[sentinel] the most recent. Blocks off the list have next = prev = -1.

import type { Calibration } from '../calibration.ts';
import { cachedBlock, indexInsert } from './content.ts';
import { KEY_BLOCK_SPAN, NO_KEY, systemBlockKey } from './keys.ts';

export type KvPoolConfig = Pick<Calibration['engine'], 'kvPoolTokens' | 'blockSize'>;

export interface KvPool {
  readonly blockSize: number;
  readonly totalBlocks: number;
  /** Per block: how many requests hold it. */
  readonly refCount: Int32Array;
  /** Per block: its content key (keys.ts), or NO_KEY. Exact for keys below 2^53. */
  readonly contentKey: Float64Array;
  /**
   * Content key → block, in two levels (content.ts): owner → [live count, block per index…].
   * Holds exactly the blocks with a key. Read it through cachedBlock.
   */
  readonly contentIndex: Map<number, number[]>;
  readonly lruNext: Int32Array;
  readonly lruPrev: Int32Array;
  /** freeStack[0 .. freeCount) are the free blocks; the top is taken first. */
  readonly freeStack: Int32Array;
  freeCount: number;
  referencedCount: number;
  evictableCount: number;
  /**
   * Content keys evicted by the latest allocating call (allocateBlocks or acquireBlocks), in
   * eviction order: evictedKeys[0 .. evictedCount). Scratch, overwritten by the next such call.
   */
  readonly evictedKeys: Float64Array;
  evictedCount: number;
  /** Evictions since the pool was created or reset. */
  evictionsTotal: number;
}

function blockCount(config: KvPoolConfig): number {
  const { kvPoolTokens, blockSize } = config;
  if (!(Number.isInteger(blockSize) && blockSize > 0)) {
    throw new RangeError(`KV block size ${blockSize} must be a positive integer`);
  }
  const total = Math.floor(kvPoolTokens / blockSize);
  if (!(total >= 1 && total < 0x7fff_ffff)) {
    throw new RangeError(`KV pool of ${kvPoolTokens} tokens gives ${total} blocks`);
  }
  return total;
}

/** An empty pool: every block free, nothing cached. A replica that rejoins after a crash starts here. */
export function createKvPool(config: KvPoolConfig): KvPool {
  const totalBlocks = blockCount(config);
  const pool: KvPool = {
    blockSize: config.blockSize,
    totalBlocks,
    refCount: new Int32Array(totalBlocks),
    contentKey: new Float64Array(totalBlocks),
    contentIndex: new Map(),
    lruNext: new Int32Array(totalBlocks + 1),
    lruPrev: new Int32Array(totalBlocks + 1),
    freeStack: new Int32Array(totalBlocks),
    freeCount: 0,
    referencedCount: 0,
    evictableCount: 0,
    evictedKeys: new Float64Array(totalBlocks),
    evictedCount: 0,
    evictionsTotal: 0,
  };
  resetKvPool(pool);
  return pool;
}

/**
 * Empty the pool in place: every block free, nothing cached, no references. A replica crash wipes
 * KV this way (02 §9); the caller must drop every block table that pointed into the pool.
 */
export function resetKvPool(pool: KvPool): void {
  const n = pool.totalBlocks;
  pool.refCount.fill(0);
  pool.contentKey.fill(NO_KEY);
  pool.contentIndex.clear();
  pool.lruNext.fill(-1);
  pool.lruPrev.fill(-1);
  pool.lruNext[n] = n;
  pool.lruPrev[n] = n;
  // Pops yield blocks 0, 1, 2, … from a fresh pool.
  for (let i = 0; i < n; i++) pool.freeStack[i] = n - 1 - i;
  pool.freeCount = n;
  pool.referencedCount = 0;
  pool.evictableCount = 0;
  pool.evictedCount = 0;
  pool.evictionsTotal = 0;
}

/**
 * The standard morning state (K21, 02 §8): only the shared system prompt's full blocks are cached,
 * unreferenced and evictable, as if one request had used them and finished. Nothing is referenced.
 */
export function createMorningKvPool(config: KvPoolConfig, systemPromptTokens: number): KvPool {
  const pool = createKvPool(config);
  const systemBlocks = systemPromptBlocks(pool, systemPromptTokens);
  if (systemBlocks > pool.totalBlocks) {
    throw new RangeError(
      `System prompt of ${systemPromptTokens} tokens needs ${systemBlocks} blocks; the pool has ${pool.totalBlocks}`,
    );
  }
  // Pop blocks 0..k-1, then release them the way a finished request does: last block first, so
  // the prompt's tail sits nearest the LRU end and block 0 is the most recently used.
  for (let i = 0; i < systemBlocks; i++) {
    const block = pool.freeStack[--pool.freeCount]!;
    const key = systemBlockKey(i);
    pool.contentKey[block] = key;
    indexInsert(pool, key, block);
  }
  for (let i = systemBlocks - 1; i >= 0; i--) {
    lruPushTail(pool, cachedBlock(pool, systemBlockKey(i)));
    pool.evictableCount++;
  }
  return pool;
}

// ----- Sizes and counters -----

/** Blocks needed to hold `tokens` tokens: ceil(tokens / blockSize). */
export function blocksForTokens(pool: KvPool, tokens: number): number {
  return tokens > 0 ? Math.ceil(tokens / pool.blockSize) : 0;
}

/** Full blocks inside a system prompt of this length: the blocks shared across sessions. */
export function systemPromptBlocks(pool: KvPool, systemPromptTokens: number): number {
  return systemPromptTokens > 0 ? Math.floor(systemPromptTokens / pool.blockSize) : 0;
}

/** Blocks an allocation can take now: free plus evictable (vLLM get_num_free_blocks). */
export function availableBlocks(pool: KvPool): number {
  return pool.freeCount + pool.evictableCount;
}

/**
 * Fraction of the pool held by requests: referenced ÷ total.
 *
 * This matches vLLM V1's kv_cache_usage_perc, which is BlockPool.get_usage() =
 * 1 − get_num_free_blocks() / (num_gpu_blocks − 1). vLLM's free queue holds both never-used and
 * cached-but-unreferenced blocks, so usage counts only blocks with ref_cnt > 0. The − 1 is vLLM's
 * reserved null block, which the simulator does not model: at 8,750 blocks the two differ by
 * about 0.01% of the pool. Cached, evictable blocks therefore do not count as used, so a warm pool
 * can read 0% while holding many sessions' histories.
 */
export function kvUsedFrac(pool: KvPool): number {
  return pool.referencedCount / pool.totalBlocks;
}

// ----- LRU list internals (used by ops.ts; not part of the public API) -----

export function lruPushTail(pool: KvPool, block: number): void {
  const { lruNext, lruPrev } = pool;
  const sentinel = pool.totalBlocks;
  const tail = lruPrev[sentinel]!;
  lruNext[tail] = block;
  lruPrev[block] = tail;
  lruNext[block] = sentinel;
  lruPrev[sentinel] = block;
}

export function lruRemove(pool: KvPool, block: number): void {
  const { lruNext, lruPrev } = pool;
  const prev = lruPrev[block]!;
  const next = lruNext[block]!;
  lruNext[prev] = next;
  lruPrev[next] = prev;
  lruNext[block] = -1;
  lruPrev[block] = -1;
}

/** Evictable blocks from least to most recently used (allocates; for tests and debugging). */
export function lruOrder(pool: KvPool): number[] {
  const order: number[] = [];
  const sentinel = pool.totalBlocks;
  for (let b = pool.lruNext[sentinel]!; b !== sentinel; b = pool.lruNext[b]!) order.push(b);
  return order;
}

// ----- Invariants -----

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`KV invariant violated: ${message}`);
}

/**
 * Checks block accounting (00-build §7.1): free + referenced + evictable = total; each block is on
 * exactly the structure its state implies; the LRU list is well formed; the content index and
 * contentKey agree. If `heldCounts` is given (heldCounts[b] = how many block tables the caller
 * holds that contain b), every refCount must equal it. O(total blocks); for tests and debug runs.
 */
export function assertKvInvariants(pool: KvPool, heldCounts?: ArrayLike<number>): void {
  const n = pool.totalBlocks;
  const { refCount, contentKey, lruNext, lruPrev, freeStack } = pool;
  check(pool.freeCount >= 0 && pool.freeCount <= n, `freeCount ${pool.freeCount}`);
  check(
    pool.freeCount + pool.referencedCount + pool.evictableCount === n,
    `free ${pool.freeCount} + referenced ${pool.referencedCount} + evictable ${pool.evictableCount} ≠ total ${n}`,
  );
  check(pool.evictedCount >= 0 && pool.evictedCount <= n, `evictedCount ${pool.evictedCount}`);

  // 1 = on the free stack, 2 = on the LRU list.
  const seen = new Uint8Array(n);
  for (let i = 0; i < pool.freeCount; i++) {
    const b = freeStack[i]!;
    check(b >= 0 && b < n, `free stack holds ${b}`);
    check(seen[b] === 0, `block ${b} is on the free stack twice`);
    seen[b] = 1;
  }
  let lruLength = 0;
  const sentinel = n;
  let last = sentinel;
  for (let b = lruNext[sentinel]!; b !== sentinel; last = b, b = lruNext[b]!) {
    check(b >= 0 && b < n, `LRU links to ${b}`);
    check(seen[b] === 0, `block ${b} is on the LRU twice or also free`);
    check(lruPrev[b] === last, `LRU prev of ${b} is ${lruPrev[b]}, expected ${last}`);
    seen[b] = 2;
    lruLength++;
    check(lruLength <= n, 'LRU has a cycle');
  }
  check(lruPrev[sentinel] === last, `LRU tail link is ${lruPrev[sentinel]}, expected ${last}`);
  check(lruLength === pool.evictableCount, `LRU length ${lruLength} ≠ ${pool.evictableCount}`);

  let referenced = 0;
  let keyed = 0;
  for (let b = 0; b < n; b++) {
    const rc = refCount[b]!;
    const key = contentKey[b]!;
    check(rc >= 0, `block ${b} refCount ${rc}`);
    if (heldCounts)
      check(rc === heldCounts[b], `block ${b} refCount ${rc} ≠ held ${heldCounts[b]}`);
    if (rc > 0) referenced++;
    if (key !== NO_KEY) {
      keyed++;
      check(Number.isSafeInteger(key) && key >= 0, `block ${b} key ${key}`);
      const indexed = cachedBlock(pool, key);
      check(indexed === b, `key ${key} of block ${b} is indexed to ${indexed}`);
    }
    const expected = rc > 0 ? 0 : key === NO_KEY ? 1 : 2;
    check(seen[b] === expected, `block ${b} (refCount ${rc}, key ${key}) is on list ${seen[b]}`);
    if (seen[b] !== 2) check(lruNext[b] === -1 && lruPrev[b] === -1, `block ${b} has LRU links`);
  }
  check(referenced === pool.referencedCount, `referenced ${referenced} ≠ ${pool.referencedCount}`);

  // The index holds exactly the keyed blocks: each entry points back at a block with that key.
  let indexed = 0;
  for (const [owner, blocks] of pool.contentIndex) {
    let live = 0;
    for (let slot = 1; slot < blocks.length; slot++) {
      const b = blocks[slot]!;
      if (b === -1) continue;
      live++;
      const key = owner * KEY_BLOCK_SPAN + slot - 1;
      check(b >= 0 && b < n && contentKey[b] === key, `index has ${key} → ${b}`);
    }
    check(live > 0 && blocks[0] === live, `owner ${owner} counts ${blocks[0]}, holds ${live}`);
    check(blocks[blocks.length - 1] !== -1, `owner ${owner} has trailing gaps`);
    indexed += live;
  }
  check(keyed === indexed, `${keyed} keyed blocks but ${indexed} index entries`);
}
