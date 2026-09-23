// S1 spike: per-block cost of the steady-state KV cycle once the pool is warm (allocate one block,
// evicting the LRU block's cached content; register the new block's content; release it to the LRU
// tail). A knee day does about 51M of these (report §4.1). Compares E4's merged block manager
// (src/engine/kv) under plain Node with the spike's owner-array layout, same access pattern as
// E4's own bench.test.ts: sessions of 64 blocks, each cycle caching the next (session, index).
// pnpm exec tsx spikes/scale/kv-cycle.ts

import {
  allocateBlocks,
  assertKvInvariants,
  createKvPool,
  registerBlock,
  releaseBlocks,
  sessionBlockKey,
  type KvPool,
} from '../../src/engine/kv/index.ts';

const engine = { kvPoolTokens: 140_000, blockSize: 16 };
const N = 2_000_000;

function best(label: string, body: () => void): void {
  body();
  let s = Infinity;
  for (let r = 0; r < 5; r++) {
    const t = process.hrtime.bigint();
    body();
    s = Math.min(s, Number(process.hrtime.bigint() - t) / 1e9);
  }
  console.log(`${label.padEnd(58)} ${((s / N) * 1e9).toFixed(0).padStart(5)} ns per cycle`);
}

// ---- E4 (merged) ----
function e4Pool(): KvPool {
  const pool = createKvPool(engine);
  const blocks = new Int32Array(pool.totalBlocks);
  allocateBlocks(pool, pool.totalBlocks, blocks, 0);
  for (let b = 0; b < pool.totalBlocks; b++) registerBlock(pool, blocks[b]!, 1e6 + b);
  releaseBlocks(pool, blocks, 0, pool.totalBlocks);
  return pool;
}
const pool = e4Pool();
const one = new Int32Array(1);
let next = 0;
best('E4 allocate+evict, register, release (plain Node)', () => {
  for (let i = 0; i < N; i++, next++) {
    allocateBlocks(pool, 1, one, 0);
    registerBlock(pool, one[0]!, sessionBlockKey(next >>> 6, next & 63));
    releaseBlocks(pool, one, 0, 1);
  }
});
assertKvInvariants(pool);

// ---- Spike owner-array layout ----
const nb = pool.totalBlocks;
const owner = new Int32Array(nb);
const ownerIdx = new Uint16Array(nb);
const nextInSeq = new Int32Array(nb).fill(-1);
const prev = new Int32Array(nb);
const nxt = new Int32Array(nb);
const ref = new Uint16Array(nb);
let head = 0;
let tail = nb - 1;
for (let b = 0; b < nb; b++) {
  prev[b] = b - 1;
  nxt[b] = b + 1 < nb ? b + 1 : -1;
  owner[b] = 1_000_000 + b; // warm: every block caches some old session's content
}
let evictions = 0;
let k = 0;
best('Spike owner arrays: allocate+evict, register, release', () => {
  for (let i = 0; i < N; i++, k++) {
    // allocate from the LRU head, evicting its content
    const b = head;
    head = nxt[b]!;
    if (head >= 0) prev[head] = -1;
    else tail = -1;
    ref[b] = 1;
    if (owner[b]! >= 0) {
      owner[b] = -1;
      evictions++;
    }
    // register (session, index) and chain it after the session's previous block
    const session = k >>> 6;
    const idx = k & 63;
    owner[b] = session;
    ownerIdx[b] = idx;
    nextInSeq[b] = -1;
    // release to the LRU tail
    ref[b] = 0;
    prev[b] = tail;
    nxt[b] = -1;
    if (tail >= 0) nxt[tail] = b;
    else head = b;
    tail = b;
  }
});
if (evictions === 0) console.log('no evictions?');

// ---- Checkpoint cost of one warm E4 pool (8 replicas = 8 of these) ----
{
  const { serialize } = await import('node:v8');
  const size = serialize(pool).length;
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) structuredClone(pool);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
  console.log(`E4 warm pool: serialized ${(size / 1e3).toFixed(0)} KB, structuredClone ${ms.toFixed(2)} ms (x8 replicas per checkpoint)`);
  const ownerSize = serialize([owner, ownerIdx, nextInSeq, prev, nxt, ref]).length;
  console.log(`Spike owner layout per replica: serialized ${(ownerSize / 1e3).toFixed(0)} KB`);
}
