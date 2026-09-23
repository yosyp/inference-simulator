// Property test: long random request lifecycles (admit with prefix hits, chunked prefill, decode
// growth, finish, preempt and recompute, abort, crash, checkpoint) against a naive reference model.
// After every operation: block accounting and refcounts hold (assertKvInvariants with the driver's
// own count of held blocks), and the pool matches the model exactly, including the LRU order, the
// free-stack order, which blocks each call returns, and which keys each allocation evicts.

import { describe, expect, it } from 'vitest';
import {
  type KvPool,
  MAX_KEY_SESSION,
  NO_KEY,
  acquireBlocks,
  allocateBlocks,
  assertKvInvariants,
  blocksForTokens,
  cachedBlock,
  cachedKeyCount,
  canAcquire,
  createMorningKvPool,
  longestCachedPrefix,
  lruOrder,
  registerFullBlocks,
  releaseBlocks,
  resetKvPool,
  sequenceBlockKey,
} from './index.ts';

// ----- Seeded PRNG (tests only; the engine's keyed RNG is E1's) -----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----- Reference model: the same rules, written the obvious way -----

interface Model {
  total: number;
  blockSize: number;
  ref: number[];
  key: number[];
  free: number[]; // stack: the last element is taken first
  lru: number[]; // least recently used first
  map: Map<number, number>;
  evictions: number;
}

function modelCreate(total: number, blockSize: number): Model {
  const free = Array.from({ length: total }, (_, i) => total - 1 - i);
  const ref = new Array<number>(total).fill(0);
  const key = new Array<number>(total).fill(NO_KEY);
  return { total, blockSize, ref, key, free, lru: [], map: new Map(), evictions: 0 };
}

function modelMorning(total: number, blockSize: number, systemTokens: number): Model {
  const m = modelCreate(total, blockSize);
  const k = Math.floor(systemTokens / blockSize);
  const blocks = modelAllocate(m, k)!.blocks;
  blocks.forEach((b, i) => modelRegister(m, b, i));
  modelRelease(m, blocks);
  return m;
}

function modelAllocate(m: Model, n: number): { blocks: number[]; evicted: number[] } | null {
  if (n > m.free.length + m.lru.length) return null;
  const blocks: number[] = [];
  const evicted: number[] = [];
  for (let i = 0; i < n; i++) {
    let b: number;
    if (m.free.length > 0) {
      b = m.free.pop()!;
    } else {
      b = m.lru.shift()!;
      evicted.push(m.key[b]!);
      m.map.delete(m.key[b]!);
      m.key[b] = NO_KEY;
      m.evictions++;
    }
    m.ref[b] = 1;
    blocks.push(b);
  }
  return { blocks, evicted };
}

function modelReference(m: Model, blocks: number[]): void {
  for (const b of blocks) {
    if (m.ref[b] === 0) m.lru.splice(m.lru.indexOf(b), 1);
    m.ref[b]!++;
  }
}

function modelRelease(m: Model, blocks: number[]): void {
  for (const b of [...blocks].reverse()) {
    m.ref[b]!--;
    if (m.ref[b] === 0) (m.key[b] === NO_KEY ? m.free : m.lru).push(b);
  }
}

function modelRegister(m: Model, b: number, key: number): void {
  if (m.key[b] === key) return;
  const existing = m.map.get(key);
  if (existing !== undefined) {
    if (m.ref[existing]! > 0) return;
    m.lru.splice(m.lru.indexOf(existing), 1);
    m.key[existing] = NO_KEY;
    m.free.push(existing);
  }
  m.map.set(key, b);
  m.key[b] = key;
}

function modelLookup(m: Model, session: number, sys: number, tokens: number): number[] {
  const maxHit = tokens > 1 ? Math.floor((tokens - 1) / m.blockSize) : 0;
  const systemBlocks = Math.floor(sys / m.blockSize);
  const hits: number[] = [];
  for (let i = 0; i < maxHit; i++) {
    const b = m.map.get(sequenceBlockKey(systemBlocks, session, i));
    if (b === undefined) break;
    hits.push(b);
  }
  return hits;
}

// ----- Comparison (plain throws: expect() is too slow for per-operation checks) -----

function assert(ok: boolean, what: string): void {
  if (!ok) throw new Error(`Check failed: ${what}`);
}

function same(actual: ArrayLike<number>, expected: ArrayLike<number>, what: string): void {
  let ok = actual.length === expected.length;
  for (let i = 0; ok && i < actual.length; i++) ok = actual[i] === expected[i];
  if (!ok) {
    throw new Error(`${what}: got [${Array.from(actual)}], model [${Array.from(expected)}]`);
  }
}

function expectMatchesModel(pool: KvPool, m: Model): void {
  same(pool.refCount, m.ref, 'refCount');
  same(pool.contentKey, m.key, 'contentKey');
  same(pool.freeStack.subarray(0, pool.freeCount), m.free, 'free stack');
  same(lruOrder(pool), m.lru, 'LRU order');
  if (cachedKeyCount(pool) !== m.map.size) throw new Error('cached key count');
  for (const [key, block] of m.map) {
    if (cachedBlock(pool, key) !== block) throw new Error(`key ${key} → ${block} in the model`);
  }
  if (pool.evictionsTotal !== m.evictions) throw new Error('eviction count');
}

// ----- Driver -----

interface Req {
  session: number;
  blocks: number[];
  held: number;
  registered: number;
  tokens: number; // tokens the request must hold KV for
  computed: number;
  target: number; // tokens at finish
}

interface Session {
  id: number;
  history: number;
  running: Req | null;
  preempted: Req | null;
}

interface Config {
  seed: number;
  blocks: number;
  blockSize: number;
  systemTokens: number;
  sessions: number;
  ops: number;
}

function runSequence(config: Config): Record<string, number> {
  const { seed, blocks, blockSize, systemTokens, ops } = config;
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const poolConfig = { kvPoolTokens: blocks * blockSize, blockSize };
  let pool = createMorningKvPool(poolConfig, systemTokens);
  let model = modelMorning(blocks, blockSize, systemTokens);
  const idPool = [0, 1, 2, 3, 2 ** 31 + 5, MAX_KEY_SESSION - 1, MAX_KEY_SESSION];
  let nextId = 10;
  const sessions: Session[] = Array.from({ length: config.sessions }, (_, i) => ({
    id: i < idPool.length ? idPool[i]! : 100 + i,
    history: systemTokens,
    running: null,
    preempted: null,
  }));
  const stats: Record<string, number> = {};
  const count = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  const allocate = (r: Req, n: number): boolean => {
    const ok = allocateBlocks(pool, n, r.blocks, r.held);
    const expected = modelAllocate(model, n);
    assert(ok === (expected !== null), 'allocate result');
    if (!ok) return false;
    same(r.blocks.slice(r.held, r.held + n), expected!.blocks, 'allocated blocks');
    same(pool.evictedKeys.subarray(0, pool.evictedCount), expected!.evicted, 'evicted keys');
    r.held += n;
    return true;
  };
  const register = (r: Req) => {
    const s = r.session;
    const before = r.registered;
    r.registered = registerFullBlocks(pool, s, systemTokens, r.blocks, 0, r.registered, r.computed);
    const systemBlocks = Math.floor(systemTokens / blockSize);
    for (let i = before; i < r.registered; i++) {
      modelRegister(model, r.blocks[i]!, sequenceBlockKey(systemBlocks, s, i));
    }
  };
  const release = (sess: Session, r: Req) => {
    releaseBlocks(pool, r.blocks, 0, r.held);
    modelRelease(model, r.blocks.slice(0, r.held));
    r.blocks.length = 0;
    r.held = 0;
    r.registered = 0;
    r.computed = 0;
    sess.running = null;
  };

  const admit = (sess: Session) => {
    let r = sess.preempted;
    if (!r) {
      const tokens = sess.history + int(1, 3 * blockSize);
      r = { session: sess.id, blocks: [], held: 0, registered: 0, tokens, computed: 0, target: 0 };
      r.target = tokens + int(1, 4 * blockSize);
    }
    const hits = longestCachedPrefix(pool, sess.id, systemTokens, r.tokens, r.blocks, 0);
    same(r.blocks.slice(0, hits), modelLookup(model, sess.id, systemTokens, r.tokens), 'hits');
    // Hits are exactly the right content, and the lookup stopped at a real miss.
    const systemBlocks = Math.floor(systemTokens / blockSize);
    for (let i = 0; i < hits; i++) {
      assert(
        pool.contentKey[r.blocks[i]!] === sequenceBlockKey(systemBlocks, sess.id, i),
        'hit key',
      );
    }
    if (hits < Math.floor((r.tokens - 1) / blockSize)) {
      assert(
        cachedBlock(pool, sequenceBlockKey(systemBlocks, sess.id, hits)) < 0,
        'lookup stopped early',
      );
    }
    const hitList = r.blocks.slice(0, hits);
    const fullNeed = blocksForTokens(pool, r.tokens) - hits;
    const available = model.free.length + model.lru.length;
    const evictableHits = hitList.filter((b) => model.ref[b] === 0).length;
    const fits = canAcquire(pool, r.blocks, 0, hits, fullNeed);
    assert(fits === fullNeed + evictableHits <= available, 'canAcquire');
    if (!fits) {
      // Sometimes try anyway: it must fail cleanly (the model comparison checks nothing changed).
      if (rand() < 0.3) {
        assert(!acquireBlocks(pool, r.blocks, 0, hits, fullNeed), 'acquire should fail');
        assert(pool.evictedCount === 0, 'failed acquire evicted');
      }
      r.blocks.length = 0;
      sess.preempted = r;
      count('gated');
      return;
    }
    const cached = hits * blockSize;
    const chunk = int(1, r.tokens - cached);
    const newCount = blocksForTokens(pool, cached + chunk) - hits;
    assert(acquireBlocks(pool, r.blocks, 0, hits, newCount), 'acquire after gate');
    modelReference(model, hitList);
    const expected = modelAllocate(model, newCount)!;
    same(r.blocks.slice(hits, hits + newCount), expected.blocks, 'acquired blocks');
    same(pool.evictedKeys.subarray(0, pool.evictedCount), expected.evicted, 'evicted keys');
    r.held = hits + newCount;
    r.registered = hits;
    r.computed = cached + chunk;
    register(r);
    sess.running = r;
    sess.preempted = null;
    count(hits > 0 ? 'admitHit' : 'admitCold');
  };

  const step = (sess: Session) => {
    const r = sess.running!;
    if (r.computed < r.tokens) {
      r.computed += int(1, r.tokens - r.computed);
    } else if (r.tokens < r.target) {
      // One or more decode steps (event-jumping covers several at once).
      r.tokens = Math.min(r.target, r.tokens + int(1, blockSize + 1));
      r.computed = r.tokens;
    } else return;
    if (!allocate(r, blocksForTokens(pool, r.computed) - r.held)) {
      count('preemptOnGrowth');
      r.tokens = Math.max(r.tokens, r.computed);
      release(sess, r);
      sess.preempted = r;
      return;
    }
    register(r);
    count('step');
  };

  for (let op = 0; op < ops; op++) {
    const sess = pick(sessions);
    const roll = rand();
    if (roll < 0.0005) {
      resetKvPool(pool);
      model = modelCreate(blocks, blockSize);
      for (const s of sessions) s.running = s.preempted = null;
      count('crash');
    } else if (roll < 0.003) {
      pool = structuredClone(pool);
      count('clone');
    } else if (!sess.running) {
      if (sess.history > 0.6 * blocks * blockSize) {
        sess.id = nextId++;
        sess.history = systemTokens;
        sess.preempted = null;
      }
      admit(sess);
    } else if (roll < 0.7) {
      step(sess);
    } else if (roll < 0.85) {
      const r = sess.running;
      if (r.computed === r.tokens) {
        sess.history = r.tokens + int(0, 1);
        release(sess, r);
        count('finish');
      }
    } else if (roll < 0.95) {
      const r = sess.running;
      r.tokens = Math.max(r.tokens, r.computed);
      release(sess, r);
      sess.preempted = r;
      count('preempt');
    } else {
      release(sess, sess.running);
      sess.preempted = null;
      count('abort');
    }

    const held = new Int32Array(blocks);
    for (const s of sessions) {
      const r = s.running;
      if (r) for (let i = 0; i < r.held; i++) held[r.blocks[i]!]!++;
    }
    assertKvInvariants(pool, held);
    expectMatchesModel(pool, model);
  }
  stats.evictions = pool.evictionsTotal;
  return stats;
}

const configs: Config[] = [];
for (let i = 0; i < 24; i++) {
  const blockSize = [1, 4, 16][Math.floor(i / 3) % 3]!;
  // No system prompt; one shorter than a block; 2 full blocks plus a straddling one; 3 exactly.
  const systemTokens = [0, blockSize - 1, 2 * blockSize + 1, 3 * blockSize][Math.floor(i / 6)]!;
  configs.push({
    seed: 1000 + i,
    blocks: [8, 16, 64][i % 3]!,
    blockSize,
    systemTokens,
    sessions: 8,
    ops: 5000,
  });
}
configs.push({ seed: 77, blocks: 512, blockSize: 16, systemTokens: 200, sessions: 32, ops: 8000 });

describe('KV pool under random request lifecycles', () => {
  it.each(configs)(
    'seed $seed: $blocks blocks × $blockSize tokens, system prompt $systemTokens',
    (config) => {
      const stats = runSequence(config);
      // The sequence must actually exercise the interesting paths.
      expect(stats.admitHit ?? 0).toBeGreaterThan(0);
      expect(stats.step ?? 0).toBeGreaterThan(0);
      expect(stats.finish ?? 0).toBeGreaterThan(0);
      expect(stats.evictions ?? 0).toBeGreaterThan(0);
    },
  );

  it('covers gating, preemption on growth, crashes, and checkpoints across the runs', () => {
    const totals: Record<string, number> = {};
    for (const config of configs.slice(0, 6)) {
      for (const [k, v] of Object.entries(runSequence({ ...config, seed: config.seed + 500 }))) {
        totals[k] = (totals[k] ?? 0) + v;
      }
    }
    for (const k of ['gated', 'preemptOnGrowth', 'preempt', 'abort', 'crash', 'clone']) {
      expect(totals[k] ?? 0, k).toBeGreaterThan(0);
    }
  });
});
