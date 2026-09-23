import { describe, expect, it } from 'vitest';
import {
  type KvPool,
  acquireBlocks,
  allocateBlocks,
  assertKvInvariants,
  blocksForTokens,
  cachedBlock,
  createKvPool,
  createMorningKvPool,
  keyBlockIndex,
  keySession,
  longestCachedPrefix,
  lruOrder,
  referenceBlocks,
  registerFullBlocks,
  releaseBlocks,
  sessionBlockKey,
  systemBlockKey,
} from './index.ts';

const B = 4;
const SYS = 10; // 2 full system blocks; block 2 straddles into the session

/** A request's block table, as E5 would keep it. */
interface Req {
  session: number;
  blocks: number[];
  held: number;
  registered: number;
  hits: number;
}

/** Admit a sequence of `tokens` tokens for `session` and compute all of it (prefill). */
function run(pool: KvPool, session: number, tokens: number): Req {
  const r: Req = { session, blocks: [], held: 0, registered: 0, hits: 0 };
  r.hits = longestCachedPrefix(pool, session, SYS, tokens, r.blocks, 0);
  const need = blocksForTokens(pool, tokens) - r.hits;
  expect(acquireBlocks(pool, r.blocks, 0, r.hits, need)).toBe(true);
  r.held = r.hits + need;
  r.registered = registerFullBlocks(pool, session, SYS, r.blocks, 0, r.hits, tokens);
  assertKvInvariants(pool);
  return r;
}

/** Decode `n` more tokens: grow at block boundaries and register blocks as they fill. */
function decode(pool: KvPool, r: Req, fromTokens: number, n: number): boolean {
  for (let t = fromTokens; t < fromTokens + n; t++) {
    if (blocksForTokens(pool, t + 1) > r.held) {
      if (!allocateBlocks(pool, 1, r.blocks, r.held)) return false;
      r.held++;
    }
    r.registered = registerFullBlocks(pool, r.session, SYS, r.blocks, 0, r.registered, t + 1);
  }
  assertKvInvariants(pool);
  return true;
}

function finish(pool: KvPool, r: Req): void {
  releaseBlocks(pool, r.blocks, 0, r.held);
  r.held = 0;
  assertKvInvariants(pool);
}

describe('longest cached prefix', () => {
  it('hits the system prompt, then the previous turn’s prompt and output', () => {
    const pool = createMorningKvPool({ kvPoolTokens: 64 * B, blockSize: B }, SYS);
    // Turn 1: 10 system + 7 message = 17 tokens; 9 output tokens. KV exists for 17 + 9 − 1 = 25.
    const t1 = run(pool, 7, 17);
    expect(t1.hits).toBe(2); // system blocks only
    expect(decode(pool, t1, 17, 8)).toBe(true);
    expect(t1.registered).toBe(6); // floor(25 / 4)
    finish(pool, t1);

    // Turn 2's prompt = turn 1's 26 tokens + a 5-token message. Blocks 0–5 are cached.
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 7, SYS, 31, out)).toBe(6);
    expect(out).toEqual(t1.blocks.slice(0, 6));
    // Another session shares only the system prompt's full blocks.
    expect(longestCachedPrefix(pool, 8, SYS, 31, out)).toBe(2);
  });

  it('never hits a partial block', () => {
    const pool = createKvPool({ kvPoolTokens: 16 * B, blockSize: B });
    const r = run(pool, 1, 14); // blocks 0–2 full, block 3 holds 2 tokens
    expect(r.registered).toBe(3);
    finish(pool, r);
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 1, SYS, 100, out)).toBe(3);
    expect(lruOrder(pool)).toHaveLength(3); // the partial block went back to the free list
    expect(pool.freeCount).toBe(13);
  });

  it('recomputes the last token: a fully cached, block-aligned sequence misses its last block', () => {
    const pool = createKvPool({ kvPoolTokens: 16 * B, blockSize: B });
    finish(pool, run(pool, 1, 16));
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 1, SYS, 16, out)).toBe(3);
    expect(longestCachedPrefix(pool, 1, SYS, 17, out)).toBe(4);
    expect(longestCachedPrefix(pool, 1, SYS, 1, out)).toBe(0);
    expect(longestCachedPrefix(pool, 1, SYS, 0, out)).toBe(0);
  });

  it('stops at a block evicted from the middle of a history', () => {
    const pool = createKvPool({ kvPoolTokens: 8 * B, blockSize: B });
    const r = run(pool, 3, 24); // blocks 0–5 cached: 0–1 system, 2–5 session 3
    finish(pool, r);
    // Touch everything but block 3, so block 3 is least recently used.
    const others = [0, 1, 2, 4, 5].map((i) => r.blocks[i]!);
    referenceBlocks(pool, others, 0, others.length);
    releaseBlocks(pool, others, 0, others.length);
    expect(lruOrder(pool)[0]).toBe(r.blocks[3]);
    // Fill the 2 free blocks and evict one more.
    const filler: number[] = [];
    expect(allocateBlocks(pool, 3, filler, 0)).toBe(true);
    expect(pool.evictedCount).toBe(1);
    expect(keySession(pool.evictedKeys[0]!)).toBe(3);
    expect(keyBlockIndex(pool.evictedKeys[0]!)).toBe(3);
    assertKvInvariants(pool);

    const out: number[] = [];
    expect(longestCachedPrefix(pool, 3, SYS, 30, out)).toBe(3);
    expect(out).toEqual(r.blocks.slice(0, 3));
    // Blocks 4–5 survive but are unreachable past the gap, as in vLLM's chained hashes.
    expect(cachedBlock(pool, sessionBlockKey(3, 4))).toBe(r.blocks[4]);
  });

  it('stops before the history when a system-prompt block is evicted', () => {
    const pool = createKvPool({ kvPoolTokens: 8 * B, blockSize: B });
    const r = run(pool, 3, 20);
    finish(pool, r);
    const sys1 = cachedBlock(pool, systemBlockKey(1));
    const rest = r.blocks.filter((b, i) => i < 5 && b !== sys1);
    referenceBlocks(pool, rest, 0, rest.length);
    releaseBlocks(pool, rest, 0, rest.length);
    const filler: number[] = [];
    allocateBlocks(pool, 4, filler, 0);
    expect(pool.evictedKeys[0]).toBe(systemBlockKey(1));
    const out: number[] = [];
    expect(longestCachedPrefix(pool, 3, SYS, 30, out)).toBe(1);
  });

  it('lets a preempted request recover the prefill whose blocks were not reused', () => {
    const pool = createKvPool({ kvPoolTokens: 10 * B, blockSize: B });
    const r = run(pool, 4, 18); // 5 blocks, 4 registered
    expect(decode(pool, r, 18, 6)).toBe(true); // 24 tokens: 6 blocks
    expect(r.registered).toBe(6);
    finish(pool, r); // preempted: blocks stay cached
    // Another request takes 4 free blocks and 2 evicted ones: r's tail (blocks 5, then 4).
    const other: number[] = [];
    expect(allocateBlocks(pool, 6, other, 0)).toBe(true);
    expect(Array.from(pool.evictedKeys.subarray(0, 2))).toEqual([
      sessionBlockKey(4, 5),
      sessionBlockKey(4, 4),
    ]);
    // Rescheduled with prompt + output so far (25 tokens): blocks 0–3 come back.
    const again: number[] = [];
    expect(longestCachedPrefix(pool, 4, SYS, 25, again)).toBe(4);
    expect(again).toEqual(r.blocks.slice(0, 4));
  });
});
