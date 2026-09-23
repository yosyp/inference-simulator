// Micro-benchmarks for the KV block manager. Skipped unless KV_BENCH is set:
//   KV_BENCH=1 pnpm vitest run --project node src/engine/kv/bench.test.ts
// Pool: the provisional calibration's 140,000 tokens at block size 16 (8,750 blocks).

import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  type KvPool,
  allocateBlocks,
  acquireBlocks,
  assertKvInvariants,
  blocksForTokens,
  cachedBlock,
  cachedKeyCount,
  canAcquire,
  createKvPool,
  createMorningKvPool,
  kvUsedFrac,
  longestCachedPrefix,
  referenceBlocks,
  registerBlock,
  registerFullBlocks,
  releaseBlocks,
  sessionBlockKey,
} from './index.ts';

const engine = { kvPoolTokens: 140_000, blockSize: 16 };
const SYS = 1_000;
const TIMEOUT_MS = 120_000;

/** Runs body once to warm up, then 3 timed runs; prints the best rate of `ops` per second. */
function time(label: string, ops: number, unit: string, body: () => void): number {
  body();
  let seconds = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = process.hrtime.bigint();
    body();
    seconds = Math.min(seconds, Number(process.hrtime.bigint() - start) / 1e9);
  }
  const rate = ops / seconds;
  const per = (seconds / ops) * 1e9;
  const perText = per >= 1e6 ? `${(per / 1e6).toFixed(2)} ms` : `${per.toFixed(0)} ns`;
  console.log(`${label.padEnd(52)} ${rate.toExponential(2).padStart(9)} ${unit}/s  (${perText})`);
  return rate;
}

/** A pool whose every block holds a distinct session's history, unreferenced. */
function fullOfHistory(): KvPool {
  const pool = createKvPool(engine);
  const blocks = new Int32Array(pool.totalBlocks);
  allocateBlocks(pool, pool.totalBlocks, blocks, 0);
  for (let b = 0; b < pool.totalBlocks; b++) registerBlock(pool, blocks[b]!, 1e6 + b);
  releaseBlocks(pool, blocks, 0, pool.totalBlocks);
  return pool;
}

describe.skipIf(!process.env.KV_BENCH)('KV micro-benchmarks', () => {
  it(
    'primitive operations',
    () => {
      const pool = fullOfHistory();
      const one = new Int32Array(1);
      const n = 1_000_000;
      // Each cycle evicts the LRU block and caches a new one; sessions hold 64 blocks each.
      let next = 0;
      time('allocate 1 with eviction + register + release', n, 'cycles', () => {
        for (let i = 0; i < n; i++, next++) {
          allocateBlocks(pool, 1, one, 0);
          registerBlock(pool, one[0]!, sessionBlockKey(next >>> 6, next & 63));
          releaseBlocks(pool, one, 0, 1);
        }
      });
      assertKvInvariants(pool);

      const free = createKvPool(engine);
      const many = new Int32Array(64);
      time('allocate 64 free + release 64 (no keys)', n * 64, 'blocks', () => {
        for (let i = 0; i < n; i++) {
          allocateBlocks(free, 64, many, 0);
          releaseBlocks(free, many, 0, 64);
        }
      });

      const hits = new Int32Array(64);
      for (let i = 0; i < 64; i++) {
        hits[i] = cachedBlock(pool, sessionBlockKey((next - 1 - i) >>> 6, (next - 1 - i) & 63));
      }
      expect(Math.min(...hits)).toBeGreaterThanOrEqual(0);
      const m = 100_000;
      time('reference + release 64 cached blocks (LRU moves)', m * 64, 'blocks', () => {
        for (let i = 0; i < m; i++) {
          referenceBlocks(pool, hits, 0, 64);
          releaseBlocks(pool, hits, 0, 64);
        }
      });
      assertKvInvariants(pool);
    },
    TIMEOUT_MS,
  );

  it(
    'prefix lookup over a long history',
    () => {
      const pool = createMorningKvPool(engine, SYS);
      const tokens = 32_000; // one session's cached 32k-token history
      const table = new Int32Array(blocksForTokens(pool, tokens));
      const hits = longestCachedPrefix(pool, 7, SYS, tokens, table, 0);
      acquireBlocks(pool, table, 0, hits, table.length - hits);
      registerFullBlocks(pool, 7, SYS, table, 0, hits, tokens);
      releaseBlocks(pool, table, 0, table.length);
      const out = new Int32Array(table.length);
      const walked = longestCachedPrefix(pool, 7, SYS, tokens + 1, out, 0);
      expect(walked).toBe(2_000);
      const reps = 5_000;
      time('longestCachedPrefix, 2,000-block hit', reps * walked, 'blocks', () => {
        for (let i = 0; i < reps; i++) longestCachedPrefix(pool, 7, SYS, tokens + 1, out, 0);
      });
    },
    TIMEOUT_MS,
  );

  it(
    'request lifecycles and checkpoint cost',
    () => {
      // Multi-turn sessions on one replica: look up, admit, decode with block growth and
      // registration, finish. 120 sessions × up to 4k tokens of history keep part of the
      // working set cached, so there are both hits and evictions. Deterministic LCG.
      const pool = createMorningKvPool(engine, SYS);
      const sessions = 120;
      const history = new Float64Array(sessions).fill(SYS);
      const table = new Int32Array(blocksForTokens(pool, 16_000));
      let seed = 12345;
      const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
      const totals = { evicted: 0, hit: 0, allocated: 0, registered: 0, released: 0, looked: 0 };
      const lifecycle = (): void => {
        const s = Math.floor(rand() * sessions);
        if (history[s]! > 4_000) history[s] = SYS;
        const prompt = history[s]! + 20 + Math.floor(rand() * 200);
        const output = 50 + Math.floor(rand() * 400);
        const hits = longestCachedPrefix(pool, s, SYS, prompt, table, 0);
        totals.hit += hits;
        totals.looked += hits + 1;
        const need = blocksForTokens(pool, prompt) - hits;
        if (!canAcquire(pool, table, 0, hits, need)) return;
        acquireBlocks(pool, table, 0, hits, need);
        totals.evicted += pool.evictedCount;
        let held = hits + need;
        let registered = registerFullBlocks(pool, s, SYS, table, 0, hits, prompt);
        const kvTokens = prompt + output - 1; // the last output token is never fed back
        for (let t = prompt; t < kvTokens; t += pool.blockSize) {
          const upTo = Math.min(t + pool.blockSize, kvTokens);
          const grow = blocksForTokens(pool, upTo) - held;
          if (grow > 0) {
            if (!allocateBlocks(pool, grow, table, held)) break;
            held += grow;
            totals.evicted += pool.evictedCount;
          }
          registered = registerFullBlocks(pool, s, SYS, table, 0, registered, upTo);
        }
        totals.allocated += held - hits;
        totals.registered += registered - hits;
        totals.released += held;
        releaseBlocks(pool, table, 0, held);
        history[s] = prompt + output;
      };
      const requests = 200_000;
      let ran = 0;
      time('request lifecycle', requests, 'requests', () => {
        for (let i = 0; i < requests; i++) lifecycle();
        ran += requests;
      });
      assertKvInvariants(pool);
      const blockOps =
        totals.looked + totals.hit + totals.allocated + totals.registered + totals.released;
      console.log(
        `  per request: ${(totals.hit / ran).toFixed(0)} hit blocks, ` +
          `${(totals.allocated / ran).toFixed(0)} allocated, ` +
          `${(totals.evicted / ran).toFixed(0)} evicted; ` +
          `${(blockOps / ran).toFixed(0)} block operations; kvUsedFrac ${kvUsedFrac(pool)}`,
      );

      const reps = 500;
      time('structuredClone of the warm 8,750-block pool', reps, 'clones', () => {
        for (let i = 0; i < reps; i++) structuredClone(pool);
      });
      console.log(
        `  serialized pool: ${(serialize(pool).length / 1024).toFixed(0)} KiB, ` +
          `${cachedKeyCount(pool)} cached keys`,
      );
    },
    TIMEOUT_MS,
  );
});
