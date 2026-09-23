import { describe, expect, it } from 'vitest';
import {
  NO_EVENT,
  assertQueue,
  createQueue,
  queueCancel,
  queueIsPending,
  queuePeekAt,
  queuePop,
  queuePush,
  type EventQueue,
  type EventView,
} from './queue.ts';

/** mulberry32: a tiny deterministic PRNG for tests (the engine's keyed RNG is E1's). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RefEntry {
  at: number;
  prio: number;
  seq: number;
  kind: number;
  a: number;
  b: number;
  handle: number;
  cancelled: boolean;
}

function view(): EventView {
  return { atMs: 0, kind: 0, a: 0, b: 0, handle: NO_EVENT };
}

function refPop(ref: RefEntry[]): RefEntry | undefined {
  let best = -1;
  for (let i = 0; i < ref.length; i++) {
    const e = ref[i]!;
    if (e.cancelled) continue;
    const b = best < 0 ? undefined : ref[best]!;
    if (
      !b ||
      e.at < b.at ||
      (e.at === b.at && (e.prio < b.prio || (e.prio === b.prio && e.seq < b.seq)))
    ) {
      best = i;
    }
  }
  if (best < 0) return undefined;
  return ref.splice(best, 1)[0];
}

/** Random push/pop/cancel against a reference list; checks every pop and the heap after each op. */
function fuzz(seed: number, ops: number, timeSpan: number, prioSpan: number, capacity = 4) {
  const rand = prng(seed);
  const q = createQueue(capacity);
  const ref: RefEntry[] = [];
  const out = view();
  let seq = 0;
  let now = 0;
  let pops = 0;
  let cancels = 0;
  const fired: number[] = [];
  const cancelled: number[] = [];
  for (let i = 0; i < ops; i++) {
    const r = rand();
    if (r < 0.5) {
      // Integer times over a small span force many exact ties.
      const at = now + Math.floor(rand() * timeSpan);
      const prio = Math.floor(rand() * prioSpan);
      const kind = 1 + Math.floor(rand() * 50);
      const a = Math.floor(rand() * 1000);
      const b = rand();
      const handle = queuePush(q, at, prio, kind, a, b);
      ref.push({ at, prio, seq: seq++, kind, a, b, handle, cancelled: false });
    } else if (r < 0.8) {
      const exp = refPop(ref);
      const got = queuePop(q, out);
      expect(got).toBe(exp !== undefined);
      if (exp) {
        expect([out.atMs, out.kind, out.a, out.b, out.handle]).toEqual([
          exp.at,
          exp.kind,
          exp.a,
          exp.b,
          exp.handle,
        ]);
        expect(out.atMs).toBeGreaterThanOrEqual(now);
        now = out.atMs;
        fired.push(out.handle);
        pops++;
        // A fired handle is no longer pending and cannot be cancelled.
        expect(queueIsPending(q, out.handle)).toBe(false);
        expect(queueCancel(q, out.handle)).toBe(false);
      }
    } else {
      const live = ref.filter((e) => !e.cancelled);
      if (live.length > 0) {
        const e = live[Math.floor(rand() * live.length)]!;
        expect(queueIsPending(q, e.handle)).toBe(true);
        expect(queueCancel(q, e.handle)).toBe(true);
        expect(queueCancel(q, e.handle)).toBe(false);
        e.cancelled = true;
        cancelled.push(e.handle);
        cancels++;
      }
    }
    assertQueue(q);
    expect(q.live).toBe(ref.filter((e) => !e.cancelled).length);
  }
  // Drain.
  for (;;) {
    const exp = refPop(ref);
    const got = queuePop(q, out);
    expect(got).toBe(exp !== undefined);
    if (!exp) break;
    expect(out.handle).toBe(exp.handle);
    fired.push(out.handle);
  }
  expect(q.live).toBe(0);
  // Handles are unique over the queue's life, so these sets must not meet.
  const firedSet = new Set(fired);
  expect(firedSet.size).toBe(fired.length);
  for (const h of cancelled) expect(firedSet.has(h)).toBe(false);
  return { pops, cancels };
}

describe('event queue heap', () => {
  it('pops in (time, priority, sequence) order under random push, pop, and cancel', () => {
    let pops = 0;
    let cancels = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = fuzz(seed, 600, seed % 2 ? 5 : 1000, seed % 3 ? 3 : 1);
      pops += r.pops;
      cancels += r.cancels;
    }
    expect(pops).toBeGreaterThan(5000);
    expect(cancels).toBeGreaterThan(2000);
  });

  it('handles fractional times and wide priority ranges', () => {
    const q = createQueue();
    const rand = prng(7);
    const items: [number, number, number][] = [];
    for (let i = 0; i < 2000; i++) {
      const at = rand() * 1e6;
      const prio = Math.floor(rand() * 0xfffff);
      items.push([at, prio, i]);
      queuePush(q, at, prio, 1, i, 0);
    }
    items.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const out = view();
    for (const [at, , i] of items) {
      expect(queuePop(q, out)).toBe(true);
      expect(out.atMs).toBe(at);
      expect(out.a).toBe(i);
    }
    expect(queuePop(q, out)).toBe(false);
  });

  it('breaks exact ties by priority, then by push order', () => {
    const q = createQueue();
    queuePush(q, 10, 5, 1, 0, 0);
    queuePush(q, 10, 1, 2, 0, 0);
    queuePush(q, 10, 5, 3, 0, 0);
    queuePush(q, 10, 1, 4, 0, 0);
    queuePush(q, 9, 9, 5, 0, 0);
    const kinds: number[] = [];
    const out = view();
    while (queuePop(q, out)) kinds.push(out.kind);
    expect(kinds).toEqual([5, 2, 4, 1, 3]);
  });

  it('treats NO_EVENT, stale, and garbage handles as not pending', () => {
    const q = createQueue(4);
    const out = view();
    expect(queueCancel(q, NO_EVENT)).toBe(false);
    expect(queueIsPending(q, NO_EVENT)).toBe(false);
    for (const h of [NaN, 1.5, -3, 2 ** 52, Infinity]) {
      expect(queueCancel(q, h)).toBe(false);
      expect(queueIsPending(q, h)).toBe(false);
    }
    const h1 = queuePush(q, 1, 0, 1, 0, 0);
    expect(queuePop(q, out)).toBe(true);
    // The slot is reused, with a new generation.
    const h2 = queuePush(q, 2, 0, 1, 0, 0);
    expect(h2).not.toBe(h1);
    expect(queueIsPending(q, h1)).toBe(false);
    expect(queueCancel(q, h1)).toBe(false);
    expect(queueIsPending(q, h2)).toBe(true);
    expect(queuePeekAt(q)).toBe(2);
  });

  it('grows from a tiny capacity and keeps order', () => {
    const q = createQueue(4);
    const rand = prng(3);
    const times: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t = Math.floor(rand() * 1e5);
      times.push(t);
      queuePush(q, t, 0, 1, 0, 0);
    }
    expect(q.capacity).toBeGreaterThanOrEqual(10_000);
    assertQueue(q);
    times.sort((x, y) => x - y);
    const out = view();
    for (const t of times) {
      queuePop(q, out);
      expect(out.atMs).toBe(t);
    }
  });

  it('compacts when cancelled entries dominate, without changing pop order', () => {
    const q = createQueue();
    const handles: number[] = [];
    for (let i = 0; i < 5000; i++) handles.push(queuePush(q, 5000 - i, 0, 1, i, 0));
    for (let i = 0; i < 5000; i++) if (i % 5 !== 0) queueCancel(q, handles[i]!);
    // Compaction ran at least once, so far fewer than 5000 entries remain in the heap.
    expect(q.size).toBeLessThan(3000);
    expect(q.live).toBe(1000);
    assertQueue(q);
    const out = view();
    const got: number[] = [];
    while (queuePop(q, out)) got.push(out.a);
    const expected = [];
    for (let i = 4995; i >= 0; i -= 5) expected.push(i);
    expect(got).toEqual(expected);
  });

  it('round-trips through structuredClone and continues identically', () => {
    const rand = prng(11);
    const q = createQueue(8);
    const out = view();
    for (let i = 0; i < 300; i++) queuePush(q, Math.floor(rand() * 100), i % 3, 1, i, 0);
    for (let i = 0; i < 100; i++) queuePop(q, out);
    const copy = structuredClone(q) as EventQueue;
    expect(copy).toEqual(q);
    const drain = (x: EventQueue) => {
      const o = view();
      const seq: number[] = [];
      const r = prng(5);
      for (let i = 0; i < 400; i++) {
        if (r() < 0.5) queuePush(x, 100 + Math.floor(r() * 100), 0, 2, i, 0);
        else if (queuePop(x, o)) seq.push(o.a, o.atMs, o.handle);
      }
      while (queuePop(x, o)) seq.push(o.a, o.atMs, o.handle);
      return seq;
    };
    expect(drain(copy)).toEqual(drain(q));
  });
});

describe('event queue throughput', () => {
  function measure(size: number, ops: number): number {
    const q = createQueue(size * 2);
    const rand = prng(size);
    const out = view();
    for (let i = 0; i < size; i++) queuePush(q, rand() * 1000, i & 7, 1, i, 0);
    const t0 = process.hrtime.bigint();
    // Steady state: each pop is followed by a push a little into the future (hold model).
    for (let i = 0; i < ops; i++) {
      queuePop(q, out);
      queuePush(q, out.atMs + rand() * 1000, i & 7, 1, i, 0);
    }
    const s = Number(process.hrtime.bigint() - t0) / 1e9;
    return (2 * ops) / s;
  }

  it('sustains millions of push+pop operations per second', () => {
    const results = [100, 1_000, 10_000, 100_000].map((size) => {
      measure(size, 50_000); // warm up
      return { size, opsPerSec: measure(size, 400_000) };
    });
    if (process.env.CORE_BENCH) console.info('queue ops/s (push + pop):', results);
    // A loose floor so slow CI machines don't flake; see README for measured figures.
    for (const r of results) expect(r.opsPerSec).toBeGreaterThan(1e6);
  });
});
