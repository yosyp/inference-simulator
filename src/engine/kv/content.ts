// Content index: which block holds each cached content key (keys.ts). vLLM keeps a flat
// hash → block map; here it has two levels so hot paths use small integer Map keys and array
// reads. owner (key ÷ KEY_BLOCK_SPAN: 0 for the system prompt, session + 1 for a session) → an
// array [live count, block of index 0, block of index 1, …] with -1 where nothing is cached.
// A prefix walk is one Map.get per owner, then array reads. Owners with no cached block are
// deleted and arrays are trimmed of trailing -1s, so the index stays proportional to the cached
// blocks (plus gaps inside a history).

import { KEY_BLOCK_SPAN } from './keys.ts';
import type { KvPool } from './pool.ts';

/** The owner's array: [live count, block per block index…], or undefined if it caches nothing. */
export function ownerBlocks(pool: KvPool, owner: number): number[] | undefined {
  return pool.contentIndex.get(owner);
}

/** The block caching this content key, or -1. */
export function cachedBlock(pool: KvPool, key: number): number {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  const blocks = pool.contentIndex.get(owner);
  if (blocks === undefined) return -1;
  const slot = key - owner * KEY_BLOCK_SPAN + 1;
  return slot < blocks.length ? blocks[slot]! : -1;
}

/** Record that `block` caches `key`. The key must not be cached already. */
export function indexInsert(pool: KvPool, key: number, block: number): void {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  const slot = key - owner * KEY_BLOCK_SPAN + 1;
  let blocks = pool.contentIndex.get(owner);
  if (blocks === undefined) {
    blocks = [0];
    pool.contentIndex.set(owner, blocks);
  }
  while (blocks.length <= slot) blocks.push(-1);
  blocks[slot] = block;
  blocks[0]!++;
}

/** Forget `key`, which must be cached. */
export function indexRemove(pool: KvPool, key: number): void {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  const blocks = pool.contentIndex.get(owner)!;
  blocks[key - owner * KEY_BLOCK_SPAN + 1] = -1;
  if (--blocks[0]! === 0) {
    pool.contentIndex.delete(owner);
    return;
  }
  // The live count is at least 1, so this stops before index 0.
  while (blocks[blocks.length - 1] === -1) blocks.pop();
}

/** Point an existing key at another block (a duplicate taking over the content). */
export function indexReplace(pool: KvPool, key: number, block: number): void {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  pool.contentIndex.get(owner)![key - owner * KEY_BLOCK_SPAN + 1] = block;
}

/** Number of cached content keys (allocates nothing; O(owners)). */
export function cachedKeyCount(pool: KvPool): number {
  let n = 0;
  for (const blocks of pool.contentIndex.values()) n += blocks[0]!;
  return n;
}
