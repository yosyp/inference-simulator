// The paged content index (content.ts) and the grow-on-demand eviction scratch (E4b). The property
// test checks the index against a reference model operation by operation; these cover the paths it
// reaches rarely: many pages per owner, sparse and out-of-order keys, page reuse, pools too big for
// Uint16 ids, and large evictions.

import { describe, expect, it } from 'vitest';
import { PAGE_SIZE } from './content.ts';
import {
  type KvPool,
  allocateBlocks,
  assertKvInvariants,
  cachedBlock,
  cachedKeyCount,
  createKvPool,
  longestCachedPrefix,
  lruOrder,
  registerBlock,
  releaseBlocks,
  resetKvPool,
  sessionBlockKey,
} from './index.ts';

/** Cache `keys` in fresh blocks, released in order, so they become evictable. */
function cache(pool: KvPool, keys: number[]): number[] {
  const blocks: number[] = [];
  expect(allocateBlocks(pool, keys.length, blocks, 0)).toBe(true);
  keys.forEach((key, i) => expect(registerBlock(pool, blocks[i]!, key)).toBe(true));
  releaseBlocks(pool, blocks, 0, blocks.length);
  return blocks;
}

describe('KV content index', () => {
  it('spans many pages per owner and frees them when the owner has nothing cached', () => {
    const pool = createKvPool({ kvPoolTokens: 4 * PAGE_SIZE, blockSize: 1 });
    const keys = Array.from({ length: 3 * PAGE_SIZE + 5 }, (_, i) => sessionBlockKey(2, i));
    const blocks = cache(pool, keys);
    assertKvInvariants(pool);
    expect(pool.contentIndex.size).toBe(1);
    expect(pool.pagesUsed).toBe(4);
    keys.forEach((key, i) => expect(cachedBlock(pool, key)).toBe(blocks[i]));
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 2, 0, keys.length + 1, out)).toBe(keys.length);
    expect(out).toEqual(blocks);

    // Evict all of them: the owner's pages go back to the free list and are reused.
    const all: number[] = [];
    expect(allocateBlocks(pool, pool.totalBlocks, all, 0)).toBe(true);
    expect(pool.evictedCount).toBe(keys.length);
    expect(cachedKeyCount(pool)).toBe(0);
    expect(pool.contentIndex.size).toBe(0);
    assertKvInvariants(pool);
    releaseBlocks(pool, all, 0, all.length);
    cache(
      pool,
      Array.from({ length: 2 * PAGE_SIZE }, (_, i) => sessionBlockKey(3, i)),
    );
    expect(pool.pagesUsed).toBe(4);
    assertKvInvariants(pool);
  });

  it('finds keys registered out of order, with gaps, and stops a prefix at a gap', () => {
    const pool = createKvPool({ kvPoolTokens: 64, blockSize: 1 });
    const indices = [3 * PAGE_SIZE + 1, 0, 1, PAGE_SIZE + 7, 2, 5 * PAGE_SIZE];
    const blocks = cache(
      pool,
      indices.map((i) => sessionBlockKey(9, i)),
    );
    assertKvInvariants(pool);
    indices.forEach((i, j) => expect(cachedBlock(pool, sessionBlockKey(9, i))).toBe(blocks[j]));
    expect(cachedBlock(pool, sessionBlockKey(9, 3))).toBe(-1);
    expect(cachedBlock(pool, sessionBlockKey(9, 2 * PAGE_SIZE))).toBe(-1);
    expect(cachedBlock(pool, sessionBlockKey(8, 0))).toBe(-1);
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 9, 0, 10 * PAGE_SIZE, out)).toBe(3);
    expect(out).toEqual([blocks[1], blocks[2], blocks[4]]);
  });

  it('keeps separate sessions apart when their keys interleave', () => {
    const pool = createKvPool({ kvPoolTokens: 256, blockSize: 1 });
    const keys: number[] = [];
    for (let i = 0; i < 100; i++) keys.push(sessionBlockKey(1, i), sessionBlockKey(2, 99 - i));
    const blocks = cache(pool, keys);
    assertKvInvariants(pool);
    keys.forEach((key, i) => expect(cachedBlock(pool, key)).toBe(blocks[i]));
    expect(cachedKeyCount(pool)).toBe(200);
  });

  it('uses 32-bit index arrays for a pool of more than 65,535 blocks', () => {
    const pool = createKvPool({ kvPoolTokens: 70_000, blockSize: 1 });
    expect(pool.pages).toBeInstanceOf(Int32Array);
    expect(pool.keyPage).toBeInstanceOf(Int32Array);
    expect(createKvPool({ kvPoolTokens: 65_535, blockSize: 1 }).pages).toBeInstanceOf(Uint16Array);
    // Take every block so the cached ones have ids above 65,535.
    const all = new Int32Array(pool.totalBlocks);
    expect(allocateBlocks(pool, pool.totalBlocks, all, 0)).toBe(true);
    const tail = Array.from(all.subarray(pool.totalBlocks - 100));
    tail.forEach((b, i) => expect(registerBlock(pool, b, sessionBlockKey(4, i))).toBe(true));
    releaseBlocks(pool, all, 0, all.length);
    tail.forEach((b, i) => expect(cachedBlock(pool, sessionBlockKey(4, i))).toBe(b));
    expect(Math.min(...tail)).toBeGreaterThan(0xffff);
    assertKvInvariants(pool);
  });

  it('grows its page store for many owners, and a reset shrinks it back', () => {
    const pool = createKvPool({ kvPoolTokens: 512, blockSize: 1 });
    const initial = pool.pages.length;
    cache(
      pool,
      Array.from({ length: 300 }, (_, s) => sessionBlockKey(s, 0)),
    );
    expect(pool.pagesUsed).toBe(300);
    expect(pool.pages.length).toBeGreaterThan(initial);
    assertKvInvariants(pool);
    resetKvPool(pool);
    expect(pool.pages.length).toBe(initial);
    assertKvInvariants(pool);
  });
});

describe('KV eviction report', () => {
  it('grows evictedKeys when one call evicts more than it holds, in LRU order', () => {
    const pool = createKvPool({ kvPoolTokens: 300, blockSize: 1 });
    const start = pool.evictedKeys.length;
    expect(start).toBeLessThan(200);
    const keys = Array.from({ length: 300 }, (_, i) => sessionBlockKey(i, 0));
    cache(pool, keys);
    const expected = lruOrder(pool)
      .slice(0, 200)
      .map((b) => pool.contentKey[b]);
    const out: number[] = [];
    expect(allocateBlocks(pool, 200, out, 0)).toBe(true);
    expect(pool.evictedCount).toBe(200);
    expect(pool.evictedKeys.length).toBeGreaterThanOrEqual(200);
    expect(Array.from(pool.evictedKeys.subarray(0, 200))).toEqual(expected);
    expect(pool.evictionsTotal).toBe(200);
    assertKvInvariants(pool);
  });
});
