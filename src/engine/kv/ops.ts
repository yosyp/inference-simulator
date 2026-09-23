// KV block operations (02 §7 rules 1, 3, 4, 5), mirroring vLLM V1's KVCacheManager and BlockPool:
// get_computed_blocks → longestCachedPrefix; allocate_slots → canAcquire / acquireBlocks /
// allocateBlocks; cache_blocks → registerFullBlocks; free → releaseBlocks.
//
// Block lists are passed as (array, start, count) so callers can keep block tables in any layout.
// Nothing here allocates per call, except the content index growing when a key is registered.

import type { SessionId } from '../api.ts';
import { cachedBlock, indexInsert, indexRemove, indexReplace, ownerBlocks } from './content.ts';
import { KEY_BLOCK_SPAN, NO_KEY, sessionBlockKey } from './keys.ts';
import { type KvPool, lruPushTail, lruRemove } from './pool.ts';

/** Where operations write block ids. A number[] grows as needed; an Int32Array must be big enough. */
export type BlockOut = Int32Array | number[];

function checkCount(n: number, what: string): void {
  if (!(n >= 0 && Number.isInteger(n))) throw new RangeError(`${what} ${n} is not a count`);
}

function checkOut(out: BlockOut, offset: number, count: number): void {
  if (!(offset >= 0 && Number.isInteger(offset))) throw new RangeError(`Offset ${offset}`);
  if (ArrayBuffer.isView(out) && offset + count > out.length) {
    throw new RangeError(`Block table of length ${out.length} can't take ${count} at ${offset}`);
  }
}

function checkBlock(pool: KvPool, block: number): void {
  if (!(block >= 0 && block < pool.totalBlocks && Number.isInteger(block))) {
    throw new RangeError(`KV block ${block} is outside the pool of ${pool.totalBlocks}`);
  }
}

/**
 * The longest cached prefix of session `session`'s sequence of `numTokens` tokens (prompt, plus any
 * output already generated when a preempted request is rescheduled). Walks the shared system-prompt
 * blocks, then the session's blocks, stopping at the first block not in the cache. Writes the hit
 * blocks to out[outOffset ..] and returns how many there are; the cached token count is that times
 * blockSize.
 *
 * Only full blocks can hit. As in vLLM, a hit never covers the last token, which must be
 * recomputed to produce logits: at most floor((numTokens − 1) / blockSize) blocks hit, so a fully
 * cached, block-aligned sequence recomputes its last block.
 *
 * Read only: it doesn't touch the LRU. The result is valid until the next call that allocates or
 * releases, so pass it straight to canAcquire / acquireBlocks.
 */
export function longestCachedPrefix(
  pool: KvPool,
  session: SessionId,
  systemPromptTokens: number,
  numTokens: number,
  out: BlockOut,
  outOffset = 0,
): number {
  const maxHit = numTokens > 1 ? Math.floor((numTokens - 1) / pool.blockSize) : 0;
  if (maxHit > KEY_BLOCK_SPAN) throw new RangeError(`Sequence of ${numTokens} tokens is too long`);
  checkOut(out, outOffset, maxHit);
  const systemBlocks = systemPromptTokens > 0 ? Math.floor(systemPromptTokens / pool.blockSize) : 0;
  const owner = sessionBlockKey(session, 0) / KEY_BLOCK_SPAN;
  // System-prompt blocks (owner 0), then the session's own; slot = block index + 1.
  let n = 0;
  const sysEnd = systemBlocks < maxHit ? systemBlocks : maxHit;
  if (sysEnd > 0) {
    const blocks = ownerBlocks(pool, 0);
    const end = blocks === undefined ? 0 : Math.min(sysEnd, blocks.length - 1);
    for (; n < end; n++) {
      const block = blocks![n + 1]!;
      if (block < 0) break;
      out[outOffset + n] = block;
    }
    if (n < sysEnd) return n;
  }
  const blocks = ownerBlocks(pool, owner);
  if (blocks === undefined) return n;
  const end = Math.min(maxHit, blocks.length - 1);
  for (; n < end; n++) {
    const block = blocks[n + 1]!;
    if (block < 0) break;
    out[outOffset + n] = block;
  }
  return n;
}

/** How many of blocks[start .. start+count) are evictable (refCount 0); referencing them uses capacity. */
export function countEvictable(
  pool: KvPool,
  blocks: ArrayLike<number>,
  start: number,
  count: number,
): number {
  let n = 0;
  for (let i = start; i < start + count; i++) if (pool.refCount[blocks[i]!] === 0) n++;
  return n;
}

/**
 * Whether the pool can reference the prefix hits blocks[start .. start+hitCount) and allocate
 * newCount more blocks. Hits that are evictable leave the available pool when referenced, so they
 * count against it (vLLM's allocate_slots check). Use it for an admission gate on the whole
 * uncached prompt (vLLM can_fit_full_sequence) while allocating only the first chunk.
 */
export function canAcquire(
  pool: KvPool,
  hits: ArrayLike<number>,
  start: number,
  hitCount: number,
  newCount: number,
): boolean {
  checkCount(newCount, 'Block count');
  const need = newCount + countEvictable(pool, hits, start, hitCount);
  return need <= pool.freeCount + pool.evictableCount;
}

// Takes n blocks, free ones first, then evicts from the LRU end. Capacity already checked.
function takeBlocks(pool: KvPool, n: number, out: BlockOut, outOffset: number): void {
  const { refCount, contentKey, freeStack, lruNext, evictedKeys } = pool;
  const sentinel = pool.totalBlocks;
  for (let i = 0; i < n; i++) {
    let block: number;
    if (pool.freeCount > 0) {
      block = freeStack[--pool.freeCount]!;
    } else {
      block = lruNext[sentinel]!;
      lruRemove(pool, block);
      pool.evictableCount--;
      const key = contentKey[block]!;
      indexRemove(pool, key);
      contentKey[block] = NO_KEY;
      evictedKeys[pool.evictedCount++] = key;
      pool.evictionsTotal++;
    }
    refCount[block] = 1;
    pool.referencedCount++;
    out[outOffset + i] = block;
  }
}

/**
 * Allocate n fresh blocks (refCount 1, no content key) into out[outOffset ..]: free blocks first,
 * then evict least recently used evictable blocks. Each eviction's content key is reported in
 * pool.evictedKeys[0 .. pool.evictedCount) (see keySession / keyBlockIndex), which lets callers
 * count Evict events and see which sessions went cold. Returns false with no state change if fewer
 * than n blocks are free or evictable; the scheduler then preempts (02 §7 rule 4).
 */
export function allocateBlocks(pool: KvPool, n: number, out: BlockOut, outOffset: number): boolean {
  pool.evictedCount = 0;
  checkCount(n, 'Block count');
  if (n > pool.freeCount + pool.evictableCount) return false;
  checkOut(out, outOffset, n);
  takeBlocks(pool, n, out, outOffset);
  return true;
}

/**
 * Add a reference to each of blocks[start .. start+count): a prefix-cache hit. Evictable blocks
 * leave the LRU. Blocks must be cached (have a content key) or already referenced.
 */
export function referenceBlocks(
  pool: KvPool,
  blocks: ArrayLike<number>,
  start: number,
  count: number,
): void {
  const { refCount, contentKey } = pool;
  for (let i = start; i < start + count; i++) {
    const block = blocks[i]!;
    checkBlock(pool, block);
    const rc = refCount[block]!;
    if (rc === 0) {
      if (contentKey[block] === NO_KEY) throw new Error(`KV block ${block} is free, not cached`);
      lruRemove(pool, block);
      pool.evictableCount--;
      pool.referencedCount++;
    }
    refCount[block] = rc + 1;
  }
}

/**
 * Admit a request's blocks in one step: reference the prefix hits table[offset .. offset+hitCount)
 * (from longestCachedPrefix) and allocate newCount fresh blocks right after them, at
 * table[offset+hitCount ..]. Hits are referenced first so the allocation can't evict them.
 * Evictions are reported as for allocateBlocks. Returns false with no state change if the pool is
 * short (see canAcquire).
 */
export function acquireBlocks(
  pool: KvPool,
  table: BlockOut,
  offset: number,
  hitCount: number,
  newCount: number,
): boolean {
  pool.evictedCount = 0;
  if (!canAcquire(pool, table, offset, hitCount, newCount)) return false;
  checkOut(table, offset + hitCount, newCount);
  referenceBlocks(pool, table, offset, hitCount);
  takeBlocks(pool, newCount, table, offset + hitCount);
  return true;
}

/**
 * Drop one reference to each of blocks[start .. start+count), on finish, abort, or preemption.
 * Blocks whose count reaches 0 keep their content: cached blocks join the LRU at the most-recent
 * end and stay findable until evicted, so a preempted request can recover part of its prefill
 * (02 §7 rule 5). Private blocks become free. Like vLLM, the list is released last block first, so
 * a sequence's tail is evicted before its head and its prefix survives longest.
 */
export function releaseBlocks(
  pool: KvPool,
  blocks: ArrayLike<number>,
  start: number,
  count: number,
): void {
  const { refCount, contentKey, freeStack } = pool;
  for (let i = start + count - 1; i >= start; i--) {
    const block = blocks[i]!;
    checkBlock(pool, block);
    const rc = refCount[block]!;
    if (rc <= 0) throw new Error(`KV block ${block} released with refCount ${rc}`);
    refCount[block] = rc - 1;
    if (rc > 1) continue;
    pool.referencedCount--;
    if (contentKey[block] !== NO_KEY) {
      lruPushTail(pool, block);
      pool.evictableCount++;
    } else {
      freeStack[pool.freeCount++] = block;
    }
  }
}

/**
 * Give a referenced, full block its content key so later lookups can hit it. Returns true if the
 * block now holds the key.
 *
 * If another block already holds the same content (two requests computed it at once, or a
 * preempted request recomputed its last block): when that copy is evictable it is retired to the
 * free list and the key moves to this block, the newer copy; when it is referenced, this block
 * stays private and false is returned. vLLM keeps both copies under one hash and serves the first;
 * lookups see the same hits either way, and kvUsedFrac is unaffected.
 */
export function registerBlock(pool: KvPool, block: number, key: number): boolean {
  checkBlock(pool, block);
  if (pool.refCount[block]! <= 0) throw new Error(`KV block ${block} registered while unheld`);
  const current = pool.contentKey[block]!;
  if (current === key) return true;
  if (current !== NO_KEY) {
    throw new Error(`KV block ${block} has key ${current}; can't register ${key}`);
  }
  if (!(key >= 0 && Number.isSafeInteger(key))) throw new RangeError(`Content key ${key}`);
  const existing = cachedBlock(pool, key);
  if (existing < 0) {
    indexInsert(pool, key, block);
  } else {
    if (pool.refCount[existing] !== 0) return false;
    lruRemove(pool, existing);
    pool.evictableCount--;
    pool.contentKey[existing] = NO_KEY;
    pool.freeStack[pool.freeCount++] = existing;
    indexReplace(pool, key, block);
  }
  pool.contentKey[block] = key;
  return true;
}

/**
 * Register every block of a sequence that has become full: blocks[start + i] holds sequence block
 * i, and blocks i in [fromBlock, floor(computedTokens / blockSize)) get their keys. Output tokens
 * fill blocks too, so turn N's full output blocks become turn N+1's cached prefix. Returns the new
 * registered-through index; pass it back as fromBlock next time (like vLLM's num_cached_block).
 * Prefix hits (already keyed) are skipped cheaply.
 */
export function registerFullBlocks(
  pool: KvPool,
  session: SessionId,
  systemPromptTokens: number,
  blocks: ArrayLike<number>,
  start: number,
  fromBlock: number,
  computedTokens: number,
): number {
  const full = Math.floor(computedTokens / pool.blockSize);
  if (full <= fromBlock) return fromBlock;
  if (full > KEY_BLOCK_SPAN) throw new RangeError(`Sequence of ${computedTokens} is too long`);
  const systemBlocks = systemPromptTokens > 0 ? Math.floor(systemPromptTokens / pool.blockSize) : 0;
  const sessionBase = sessionBlockKey(session, 0);
  for (let i = fromBlock; i < full; i++) {
    registerBlock(pool, blocks[start + i]!, i < systemBlocks ? i : sessionBase + i);
  }
  return full;
}
