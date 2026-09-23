// KV block operations (02 §7 rules 1, 3, 4, 5), mirroring vLLM V1's KVCacheManager and BlockPool:
// get_computed_blocks → longestCachedPrefix; allocate_slots → canAcquire / acquireBlocks /
// allocateBlocks; cache_blocks → registerFullBlocks; free → releaseBlocks.
//
// Block lists are passed as (array, start, count) so callers can keep block tables in any layout.
// Nothing here allocates per call, except the content index growing when a key is registered.
//
// Once the pool is warm, every block allocated evicts one: about 50M allocate, evict, register and
// release cycles per busy simulated day. Those paths are kept small so V8 can inline them into the
// caller: one-block calls take a short path, error messages are built in separate functions, and
// multi-block calls update pool counters and LRU links once per call rather than once per block.

import type { SessionId } from '../api.ts';
import { indexAdd, indexRemove, indexReplace, walkCached } from './content.ts';
import { KEY_BLOCK_SPAN, NO_KEY, sessionBlockKey } from './keys.ts';
import { type KvPool, lruRemove } from './pool.ts';

/** Where operations write block ids. A number[] grows as needed; an Int32Array must be big enough. */
export type BlockOut = Int32Array | number[];

// ----- Argument checks -----

function checkCount(n: number, what: string): void {
  if (!(n >= 0 && Number.isInteger(n))) throw countError(n, what);
}

function checkOut(out: BlockOut, offset: number, count: number): void {
  if (
    !(offset >= 0 && Number.isInteger(offset)) ||
    (ArrayBuffer.isView(out) && offset + count > out.length)
  ) {
    throw outError(out, offset, count);
  }
}

function checkBlock(pool: KvPool, block: number): void {
  if (!(block >= 0 && block < pool.totalBlocks && Number.isInteger(block))) {
    throw blockError(pool, block);
  }
}

// Errors are built out of line so the functions above stay small.

function countError(n: number, what: string): RangeError {
  return new RangeError(`${what} ${n} is not a count`);
}

function outError(out: BlockOut, offset: number, count: number): RangeError {
  if (!(offset >= 0 && Number.isInteger(offset))) return new RangeError(`Offset ${offset}`);
  return new RangeError(`Block table of length ${out.length} can't take ${count} at ${offset}`);
}

function blockError(pool: KvPool, block: number): RangeError {
  return new RangeError(`KV block ${block} is outside the pool of ${pool.totalBlocks}`);
}

function releaseError(pool: KvPool, block: number, rc: number): Error {
  if (!(block >= 0 && block < pool.totalBlocks && Number.isInteger(block))) {
    return blockError(pool, block);
  }
  return new Error(`KV block ${block} released with refCount ${rc}`);
}

function registerError(block: number, current: number, key: number): Error {
  if (current === NO_KEY) return new Error(`KV block ${block} registered while unheld`);
  return new Error(`KV block ${block} has key ${current}; can't register ${key}`);
}

function keyError(key: number): RangeError {
  return new RangeError(`Content key ${key}`);
}

// ----- Lookup -----

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
  sessionBlockKey(session, 0); // checks the session id
  const owner = session + 1;
  // System-prompt blocks (owner 0), then the session's own.
  const sysEnd = systemBlocks < maxHit ? systemBlocks : maxHit;
  const n = walkCached(pool, 0, 0, sysEnd | 0, out, outOffset);
  if (n < sysEnd) return n;
  return walkCached(pool, owner, n, maxHit | 0, out, outOffset);
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

// ----- Allocation -----

// Takes n blocks into out[outOffset ..]: free ones first (top of the stack first), then the least
// recently used evictable ones. Capacity already checked.
function takeBlocks(pool: KvPool, n: number, out: BlockOut, outOffset: number): void {
  const free = pool.freeCount < n ? pool.freeCount : n;
  if (free > 0) {
    const { refCount, freeStack } = pool;
    let top = pool.freeCount;
    for (let i = 0; i < free; i++) {
      const block = freeStack[--top]!;
      refCount[block] = 1;
      out[outOffset + i] = block;
    }
    pool.freeCount = top;
  }
  if (free < n) evict(pool, n - free, out, outOffset + free);
  pool.referencedCount += n;
}

// Takes the k least recently used evictable blocks into out[at ..], dropping their content keys
// and reporting them in evictedKeys.
function evict(pool: KvPool, k: number, out: BlockOut, at: number): void {
  if (k > pool.evictedKeys.length) {
    // Scratch only, so nothing to copy; grown geometrically, never past the pool.
    pool.evictedKeys = new Float64Array(
      Math.min(pool.totalBlocks, Math.max(k, 2 * pool.evictedKeys.length)),
    );
  }
  const { refCount, contentKey, lruNext, lruPrev, evictedKeys } = pool;
  const sentinel = pool.totalBlocks;
  let block = lruNext[sentinel]!;
  for (let i = 0; i < k; i++) {
    const next = lruNext[block]!;
    evictedKeys[i] = contentKey[block]!;
    indexRemove(pool, block);
    contentKey[block] = NO_KEY;
    refCount[block] = 1;
    out[at + i] = block;
    block = next;
  }
  lruNext[sentinel] = block;
  lruPrev[block] = sentinel;
  pool.evictableCount -= k;
  pool.evictedCount = k;
  pool.evictionsTotal += k;
}

// evict for one block, without the loop.
function evictOne(pool: KvPool, out: BlockOut, at: number): void {
  const lruNext = pool.lruNext;
  const sentinel = pool.totalBlocks;
  const block = lruNext[sentinel]!;
  const next = lruNext[block]!;
  lruNext[sentinel] = next;
  pool.lruPrev[next] = sentinel;
  pool.evictedKeys[0] = pool.contentKey[block]!;
  indexRemove(pool, block);
  pool.contentKey[block] = NO_KEY;
  pool.refCount[block] = 1;
  out[at] = block;
  pool.evictableCount--;
  pool.evictedCount = 1;
  pool.evictionsTotal++;
  pool.referencedCount++;
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
  // The usual case in a warm pool: one block, none free, so one eviction, into a valid slot.
  if (
    n === 1 &&
    pool.freeCount === 0 &&
    pool.evictableCount > 0 &&
    outOffset >= 0 &&
    Number.isInteger(outOffset) &&
    !(ArrayBuffer.isView(out) && outOffset >= out.length)
  ) {
    evictOne(pool, out, outOffset);
    return true;
  }
  return allocateAny(pool, n, out, outOffset);
}

// allocateBlocks in general.
function allocateAny(pool: KvPool, n: number, out: BlockOut, outOffset: number): boolean {
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

// ----- Release -----

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
  if (count === 1) releaseOne(pool, blocks[start]!);
  else releaseMany(pool, blocks, start, count);
}

function releaseMany(pool: KvPool, blocks: ArrayLike<number>, start: number, count: number): void {
  const { refCount, contentKey, freeStack, lruNext, lruPrev } = pool;
  const sentinel = pool.totalBlocks;
  // Cached blocks are appended after `tail`, the most recently used end of the LRU.
  let tail = lruPrev[sentinel]!;
  let free = pool.freeCount;
  let released = 0;
  for (let i = start + count - 1; i >= start; i--) {
    const block = blocks[i]!;
    const rc = block >= 0 && block < sentinel ? refCount[block]! : 0;
    if (!(rc > 0 && Number.isInteger(block))) {
      endRelease(pool, tail, free, released);
      throw releaseError(pool, block, rc);
    }
    refCount[block] = rc - 1;
    if (rc > 1) continue;
    released++;
    if (contentKey[block] !== NO_KEY) {
      lruNext[tail] = block;
      lruPrev[block] = tail;
      tail = block;
    } else {
      freeStack[free++] = block;
    }
  }
  endRelease(pool, tail, free, released);
}

// Close the LRU after `tail` and write releaseBlocks' counts back to the pool.
function endRelease(pool: KvPool, tail: number, free: number, released: number): void {
  const sentinel = pool.totalBlocks;
  pool.lruNext[tail] = sentinel;
  pool.lruPrev[sentinel] = tail;
  pool.evictableCount += released - (free - pool.freeCount);
  pool.referencedCount -= released;
  pool.freeCount = free;
}

// releaseBlocks for one block, without the loop.
function releaseOne(pool: KvPool, block: number): void {
  const refCount = pool.refCount;
  // A typed array reads undefined at any index outside it, including fractions.
  const rc = refCount[block]!;
  if (!(rc > 0)) throw releaseError(pool, block, rc);
  refCount[block] = rc - 1;
  if (rc === 1) {
    pool.referencedCount--;
    if (pool.contentKey[block] === NO_KEY) {
      pool.freeStack[pool.freeCount++] = block;
    } else {
      // lruPushTail, written out.
      const { lruNext, lruPrev } = pool;
      const sentinel = pool.totalBlocks;
      const tail = lruPrev[sentinel]!;
      lruNext[tail] = block;
      lruPrev[block] = tail;
      lruNext[block] = sentinel;
      lruPrev[sentinel] = block;
      pool.evictableCount++;
    }
  }
}

// ----- Registration -----

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
  return register(pool, block, key, -1);
}

// registerBlock, where `from` is an index page of the key's owner to search from, or -1
// (content.ts).
function register(pool: KvPool, block: number, key: number, from: number): boolean {
  // The usual case: a held block with no key yet, and a valid key. (refCount reads undefined for
  // a block outside the pool.)
  if (
    !(pool.refCount[block]! > 0 && pool.contentKey[block] === NO_KEY) ||
    !(key >= 0 && Number.isSafeInteger(key))
  ) {
    return registerOther(pool, block, key);
  }
  const holder = indexAdd(pool, key, block, from);
  if (holder >= 0) return registerDuplicate(pool, key, block, holder);
  pool.contentKey[block] = key;
  return true;
}

// register's other cases, checked in order: a block outside the pool or not held, a block that
// already has this key (true), or another key, or an invalid key.
function registerOther(pool: KvPool, block: number, key: number): boolean {
  checkBlock(pool, block);
  const current = pool.contentKey[block]!;
  if (pool.refCount[block]! <= 0) throw registerError(block, NO_KEY, key);
  if (current === key) return true;
  if (current !== NO_KEY) throw registerError(block, current, key);
  throw keyError(key);
}

// Another block, `holder`, holds the content being registered. If it is evictable, it loses the key
// and becomes free, and `block` takes the key (true); if it is referenced, `block` stays private
// (false).
function registerDuplicate(pool: KvPool, key: number, block: number, holder: number): boolean {
  if (pool.refCount[holder] !== 0) return false;
  indexReplace(pool, holder, key, block);
  lruRemove(pool, holder);
  pool.contentKey[holder] = NO_KEY;
  pool.freeStack[pool.freeCount++] = holder;
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
  const { contentKey, keyPage } = pool;
  for (let i = fromBlock; i < full; i++) {
    const key = i < systemBlocks ? i : sessionBase + i;
    // The block before this one usually holds key − 1 (same owner, since i > 0): its index page is
    // this key's page or the one before it, a step at most.
    const before = i > 0 ? blocks[start + i - 1] : undefined;
    const from = before !== undefined && contentKey[before] === key - 1 ? keyPage[before]! : -1;
    register(pool, blocks[start + i]!, key, from);
  }
  return full;
}
