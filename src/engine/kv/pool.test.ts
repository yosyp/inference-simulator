import { describe, expect, it } from 'vitest';
import type { Calibration } from '../calibration.ts';
import {
  type KvPool,
  NO_KEY,
  acquireBlocks,
  allocateBlocks,
  assertKvInvariants,
  availableBlocks,
  blocksForTokens,
  cachedBlock,
  canAcquire,
  createKvPool,
  createMorningKvPool,
  keySession,
  kvUsedFrac,
  longestCachedPrefix,
  lruOrder,
  referenceBlocks,
  registerBlock,
  registerFullBlocks,
  releaseBlocks,
  resetKvPool,
  sessionBlockKey,
  systemBlockKey,
  systemPromptBlocks,
} from './index.ts';

// 8 blocks of 4 tokens.
const small = { kvPoolTokens: 32, blockSize: 4 };

/** Pool state minus the per-call eviction scratch, for "nothing changed" comparisons. */
function stateOf(pool: KvPool): unknown {
  const { evictedCount: _c, evictedKeys: _k, ...rest } = structuredClone(pool);
  return rest;
}

/** Allocate n blocks and give block i of the list key `keys[i]` (a finished request's history). */
function cache(pool: KvPool, keys: number[]): number[] {
  const blocks: number[] = [];
  expect(allocateBlocks(pool, keys.length, blocks, 0)).toBe(true);
  keys.forEach((key, i) => expect(registerBlock(pool, blocks[i]!, key)).toBe(true));
  releaseBlocks(pool, blocks, 0, blocks.length);
  assertKvInvariants(pool);
  return blocks;
}

describe('KV pool', () => {
  it('sizes the pool from the calibration: kvPoolTokens / blockSize blocks, all free', () => {
    // The provisional calibration's engine block (only src/data reads the JSON).
    const engine: Calibration['engine'] = {
      kvPoolTokens: 140_000,
      blockSize: 16,
      maxNumSeqs: 256,
      maxNumBatchedTokens: 8192,
      maxModelLen: 131_072,
    };
    const pool = createKvPool(engine);
    expect(pool.totalBlocks).toBe(140_000 / 16);
    expect(pool.freeCount).toBe(pool.totalBlocks);
    expect(pool.referencedCount + pool.evictableCount).toBe(0);
    expect(kvUsedFrac(pool)).toBe(0);
    assertKvInvariants(pool);
  });

  it('rejects impossible configurations', () => {
    expect(() => createKvPool({ kvPoolTokens: 32, blockSize: 0 })).toThrow(RangeError);
    expect(() => createKvPool({ kvPoolTokens: 3, blockSize: 4 })).toThrow(RangeError);
    expect(() => createMorningKvPool(small, 40)).toThrow(RangeError);
  });

  it('counts blocks for tokens and system-prompt blocks', () => {
    const pool = createKvPool(small);
    expect([0, 1, 4, 5, 8].map((t) => blocksForTokens(pool, t))).toEqual([0, 1, 1, 2, 2]);
    expect([0, 3, 4, 11, 12].map((t) => systemPromptBlocks(pool, t))).toEqual([0, 0, 1, 2, 3]);
  });

  it('starts the morning with only the system prompt cached, evictable, and 0% used (K21)', () => {
    const pool = createMorningKvPool(small, 10); // 2 full blocks; tokens 8–9 are partial
    assertKvInvariants(pool);
    expect(pool.evictableCount).toBe(2);
    expect(pool.freeCount).toBe(6);
    expect(pool.referencedCount).toBe(0);
    expect(kvUsedFrac(pool)).toBe(0);
    // Released last block first: the prompt's tail is evicted first, block 0 last.
    const [b0, b1] = [0, 1].map((i) => cachedBlock(pool, systemBlockKey(i)));
    expect(lruOrder(pool)).toEqual([b1, b0]);
    // Any session hits both system blocks, never the straddling block.
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 5, 10, 30, out)).toBe(2);
    expect(out).toEqual([b0, b1]);
  });

  it('allocates free blocks before evicting cached ones', () => {
    const pool = createMorningKvPool(small, 8);
    const out = new Int32Array(8);
    expect(allocateBlocks(pool, 6, out, 0)).toBe(true);
    expect(pool.evictedCount).toBe(0);
    expect(pool.evictableCount).toBe(2);
    expect(allocateBlocks(pool, 1, out, 6)).toBe(true);
    expect(pool.evictedCount).toBe(1);
    expect(pool.evictedKeys[0]).toBe(systemBlockKey(1));
    expect(pool.evictionsTotal).toBe(1);
    assertKvInvariants(pool);
  });

  it('fails an allocation it cannot satisfy, changing nothing', () => {
    const pool = createMorningKvPool(small, 8);
    const held = [0, 0, 0];
    expect(allocateBlocks(pool, 3, held, 0)).toBe(true);
    const before = stateOf(pool);
    const out = new Int32Array(8).fill(-7);
    expect(allocateBlocks(pool, 6, out, 0)).toBe(false);
    expect(pool.evictedCount).toBe(0);
    expect(stateOf(pool)).toEqual(before);
    expect(Array.from(out)).toEqual(new Array(8).fill(-7));
    expect(allocateBlocks(pool, 5, out, 0)).toBe(true);
    expect(availableBlocks(pool)).toBe(0);
    expect(kvUsedFrac(pool)).toBe(1);
    assertKvInvariants(pool);
  });

  it('counts only referenced blocks as used, like vLLM kv_cache_usage_perc', () => {
    const pool = createKvPool(small);
    const keys = [0, 1, 2].map((i) => sessionBlockKey(1, i));
    const blocks = cache(pool, keys);
    expect(kvUsedFrac(pool)).toBe(0);
    referenceBlocks(pool, blocks, 0, 2);
    expect(kvUsedFrac(pool)).toBe(2 / 8);
    const scratch = [0, 0];
    allocateBlocks(pool, 2, scratch, 0);
    expect(kvUsedFrac(pool)).toBe(4 / 8);
    expect(pool.freeCount + pool.referencedCount + pool.evictableCount).toBe(8);
  });
});

describe('KV LRU order', () => {
  it('evicts in release order, a request’s tail before its head, and hits refresh recency', () => {
    const pool = createKvPool(small);
    const a = cache(
      pool,
      [0, 1, 2].map((i) => sessionBlockKey(1, i)),
    ); // released first
    const b = cache(
      pool,
      [0, 1, 2].map((i) => sessionBlockKey(2, i)),
    );
    expect(lruOrder(pool)).toEqual([a[2], a[1], a[0], b[2], b[1], b[0]]);
    // A hit on session 1's first two blocks, then release: they become most recent.
    referenceBlocks(pool, a, 0, 2);
    expect(lruOrder(pool)).toEqual([a[2], b[2], b[1], b[0]]);
    releaseBlocks(pool, a, 0, 2);
    expect(lruOrder(pool)).toEqual([a[2], b[2], b[1], b[0], a[1], a[0]]);
    assertKvInvariants(pool);

    // 2 free blocks remain; the next 4 allocations evict in exactly LRU order.
    const out: number[] = [];
    expect(allocateBlocks(pool, 6, out, 0)).toBe(true);
    expect(out.slice(2)).toEqual([a[2], b[2], b[1], b[0]]);
    expect(Array.from(pool.evictedKeys.subarray(0, pool.evictedCount))).toEqual([
      sessionBlockKey(1, 2),
      sessionBlockKey(2, 2),
      sessionBlockKey(2, 1),
      sessionBlockKey(2, 0),
    ]);
    expect(keySession(pool.evictedKeys[3]!)).toBe(2);
    expect(lruOrder(pool)).toEqual([a[1], a[0]]);
    assertKvInvariants(pool);
  });

  it('keeps shared blocks off the LRU until the last holder releases them', () => {
    const pool = createMorningKvPool(small, 8);
    const sys = [0, 1].map((i) => cachedBlock(pool, systemBlockKey(i)));
    referenceBlocks(pool, sys, 0, 2);
    referenceBlocks(pool, sys, 0, 2);
    expect(pool.refCount[sys[0]!]).toBe(2);
    expect(lruOrder(pool)).toEqual([]);
    releaseBlocks(pool, sys, 0, 2);
    expect(lruOrder(pool)).toEqual([]);
    expect(pool.referencedCount).toBe(2);
    releaseBlocks(pool, sys, 0, 2);
    expect(lruOrder(pool)).toEqual([sys[1], sys[0]]);
    assertKvInvariants(pool);
  });

  it('returns private blocks to the free list, not the LRU', () => {
    const pool = createKvPool(small);
    const out: number[] = [];
    allocateBlocks(pool, 3, out, 0);
    registerBlock(pool, out[0]!, sessionBlockKey(1, 0));
    releaseBlocks(pool, out, 0, 3);
    expect(lruOrder(pool)).toEqual([out[0]]);
    expect(pool.freeCount).toBe(7);
    assertKvInvariants(pool);
  });
});

describe('KV acquire', () => {
  it('counts evictable hits against capacity and fails without partial change', () => {
    const pool = createKvPool(small);
    const hist = cache(
      pool,
      [0, 1, 2, 3].map((i) => sessionBlockKey(1, i)),
    );
    const other: number[] = [];
    allocateBlocks(pool, 3, other, 0); // 1 free + 4 evictable left
    const table: number[] = [];
    const hits = longestCachedPrefix(pool, 1, 0, 17, table);
    expect(hits).toBe(4);
    expect(table).toEqual(hist);
    // 2 new blocks alone would fit in 5 available, but referencing the 4 evictable hits leaves 1.
    expect(canAcquire(pool, table, 0, hits, 2)).toBe(false);
    const before = stateOf(pool);
    expect(acquireBlocks(pool, table, 0, hits, 2)).toBe(false);
    expect(stateOf(pool)).toEqual(before);
    expect(canAcquire(pool, table, 0, hits, 1)).toBe(true);
    expect(acquireBlocks(pool, table, 0, hits, 1)).toBe(true);
    expect(pool.evictedCount).toBe(0);
    expect(table.slice(0, 4)).toEqual(hist);
    assertKvInvariants(pool);
  });

  it('never evicts the hits it is referencing', () => {
    const pool = createKvPool({ kvPoolTokens: 16, blockSize: 4 });
    const hist = cache(
      pool,
      [0, 1].map((i) => sessionBlockKey(1, i)),
    );
    cache(
      pool,
      [0, 1].map((i) => sessionBlockKey(2, i)),
    );
    // Session 1's blocks are at the LRU end; the new block must evict session 2's instead.
    const table: number[] = [];
    const hits = longestCachedPrefix(pool, 1, 0, 12, table);
    expect(acquireBlocks(pool, table, 0, hits, 1)).toBe(true);
    expect(table.slice(0, 2)).toEqual(hist);
    expect(keySession(pool.evictedKeys[0]!)).toBe(2);
    assertKvInvariants(pool);
  });

  it('rejects a block table too short for the result', () => {
    const pool = createKvPool(small);
    expect(() => allocateBlocks(pool, 3, new Int32Array(2), 0)).toThrow(RangeError);
    expect(() => allocateBlocks(pool, -1, [], 0)).toThrow(RangeError);
    assertKvInvariants(pool);
  });
});

describe('KV registration', () => {
  it('moves a key from an evictable duplicate to the new copy', () => {
    const pool = createKvPool(small);
    const key = sessionBlockKey(1, 0);
    const [old] = cache(pool, [key]);
    const fresh: number[] = [];
    allocateBlocks(pool, 1, fresh, 0);
    expect(registerBlock(pool, fresh[0]!, key)).toBe(true);
    expect(cachedBlock(pool, key)).toBe(fresh[0]);
    expect(pool.contentKey[old!]).toBe(NO_KEY);
    expect(pool.evictableCount).toBe(0);
    assertKvInvariants(pool);
  });

  it('leaves a duplicate private while the first copy is in use', () => {
    const pool = createKvPool(small);
    const key = systemBlockKey(0);
    const a: number[] = [];
    const b: number[] = [];
    allocateBlocks(pool, 1, a, 0);
    allocateBlocks(pool, 1, b, 0);
    expect(registerBlock(pool, a[0]!, key)).toBe(true);
    expect(registerBlock(pool, b[0]!, key)).toBe(false);
    expect(pool.contentKey[b[0]!]).toBe(NO_KEY);
    expect(registerBlock(pool, a[0]!, key)).toBe(true);
    expect(() => registerBlock(pool, a[0]!, systemBlockKey(1))).toThrow();
    releaseBlocks(pool, b, 0, 1);
    expect(() => registerBlock(pool, b[0]!, systemBlockKey(2))).toThrow();
    assertKvInvariants(pool);
  });

  it('registers exactly the full blocks, through the partial one', () => {
    const pool = createKvPool(small);
    const table: number[] = [];
    allocateBlocks(pool, 3, table, 0);
    // System prompt of 6 tokens: block 0 is shared, block 1 straddles and belongs to session 9.
    expect(registerFullBlocks(pool, 9, 6, table, 0, 0, 11)).toBe(2);
    expect(pool.contentKey[table[0]!]).toBe(systemBlockKey(0));
    expect(pool.contentKey[table[1]!]).toBe(sessionBlockKey(9, 1));
    expect(pool.contentKey[table[2]!]).toBe(NO_KEY);
    expect(registerFullBlocks(pool, 9, 6, table, 0, 2, 11)).toBe(2);
    expect(registerFullBlocks(pool, 9, 6, table, 0, 2, 12)).toBe(3);
    expect(pool.contentKey[table[2]!]).toBe(sessionBlockKey(9, 2));
    assertKvInvariants(pool);
  });
});

describe('KV misuse', () => {
  it('throws on releasing an unheld block or referencing a free one', () => {
    const pool = createKvPool(small);
    expect(() => releaseBlocks(pool, [0], 0, 1)).toThrow();
    expect(() => referenceBlocks(pool, [0], 0, 1)).toThrow();
    expect(() => referenceBlocks(pool, [99], 0, 1)).toThrow(RangeError);
  });
});

describe('KV reset and cloning', () => {
  it('wipes everything on reset (crash)', () => {
    const pool = createMorningKvPool(small, 8);
    const held: number[] = [];
    allocateBlocks(pool, 4, held, 0);
    registerBlock(pool, held[0]!, sessionBlockKey(3, 2));
    resetKvPool(pool);
    assertKvInvariants(pool);
    expect(stateOf(pool)).toEqual(stateOf(createKvPool(small)));
  });

  it('round-trips through structuredClone and evolves identically', () => {
    const pool = createMorningKvPool(small, 8);
    cache(
      pool,
      [2, 3, 4].map((i) => sessionBlockKey(1, i)),
    );
    const held: number[] = [];
    allocateBlocks(pool, 2, held, 0);
    const copy = structuredClone(pool);
    expect(copy).toEqual(pool);
    expect(copy.contentIndex).toBeInstanceOf(Map);
    expect(copy.refCount).toBeInstanceOf(Int32Array);
    assertKvInvariants(copy);
    for (const p of [pool, copy]) {
      const out: number[] = [];
      expect(allocateBlocks(p, 5, out, 0)).toBe(true);
      releaseBlocks(p, held, 0, 2);
      releaseBlocks(p, out, 0, 5);
    }
    expect(copy).toEqual(pool);
    expect(copy.refCount).not.toBe(pool.refCount);
  });
});
