import { describe, expect, it } from 'vitest';
import {
  affinityTarget,
  buildRing,
  modNLookup,
  ringLookup,
  ringSuccessor,
  routableSet,
  sessionHash,
  type HashRing,
} from './index.ts';

const ALL8 = [0, 1, 2, 3, 4, 5, 6, 7];
const SESSIONS = 10_000;

function without(ids: number[], r: number): number[] {
  return ids.filter((x) => x !== r);
}

/** Fraction of SESSIONS sessions whose affinity target differs between two routable sets. */
function movedFraction(
  seed: number,
  ring: HashRing,
  scheme: 'modN' | 'consistent',
  from: number[],
  to: number[],
): number {
  const a = routableSet(8, from);
  const b = routableSet(8, to);
  let moved = 0;
  for (let s = 0; s < SESSIONS; s++) {
    const h = sessionHash(seed, 0, s);
    if (affinityTarget(a, ring, scheme, h) !== affinityTarget(b, ring, scheme, h)) moved++;
  }
  return moved / SESSIONS;
}

describe('session hash', () => {
  it('is a keyed draw: stable per (seed, day, session), different across them', () => {
    expect(sessionHash(1, 0, 17)).toBe(sessionHash(1, 0, 17));
    expect(sessionHash(1, 0, 17)).not.toBe(sessionHash(1, 0, 18));
    expect(sessionHash(1, 0, 17)).not.toBe(sessionHash(1, 1, 17));
    expect(sessionHash(1, 0, 17)).not.toBe(sessionHash(2, 0, 17));
    const h = sessionHash(9, 3, 123_456);
    expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
  });
});

describe('hash ring', () => {
  it('holds every virtual node in ascending order, deterministically', () => {
    const ring = buildRing(7, 8, 64);
    expect(ring.pos.length).toBe(512);
    for (let i = 1; i < ring.pos.length; i++) {
      expect(ring.pos[i]!).toBeGreaterThanOrEqual(ring.pos[i - 1]!);
    }
    const perReplica = new Array<number>(8).fill(0);
    for (const o of ring.owner) perReplica[o]!++;
    expect(perReplica).toEqual(new Array<number>(8).fill(64));
    expect(buildRing(7, 8, 64)).toEqual(ring);
    expect(buildRing(8, 8, 64)).not.toEqual(ring);
    expect(buildRing(7, 2, 0).pos.length).toBe(2); // at least one point per replica
  });

  it('finds the first point at or after the hash and wraps past the last', () => {
    const ring: HashRing = {
      pos: new Uint32Array([100, 200, 300]),
      owner: new Uint16Array([0, 1, 2]),
    };
    expect(ringSuccessor(ring, 0)).toBe(0);
    expect(ringSuccessor(ring, 100)).toBe(0);
    expect(ringSuccessor(ring, 101)).toBe(1);
    expect(ringSuccessor(ring, 300)).toBe(2);
    expect(ringSuccessor(ring, 301)).toBe(0);
  });

  it('falls through an unroutable owner to the next point on the ring', () => {
    const ring: HashRing = {
      pos: new Uint32Array([100, 200, 300, 400]),
      owner: new Uint16Array([0, 1, 1, 2]),
    };
    const all = new Uint8Array([1, 1, 1]);
    expect(ringLookup(ring, 150, all)).toBe(1);
    expect(ringLookup(ring, 150, new Uint8Array([1, 0, 1]))).toBe(2);
    expect(ringLookup(ring, 350, new Uint8Array([1, 1, 0]))).toBe(0); // wraps
    expect(ringLookup(ring, 350, new Uint8Array([0, 0, 0]))).toBe(-1);
  });
});

describe('mod-N', () => {
  it('indexes the ascending routable list with hash mod count', () => {
    const set = routableSet(8, [6, 1, 3]);
    expect([...set.routableList.subarray(0, set.routableCount)]).toEqual([1, 3, 6]);
    expect(modNLookup(0, set.routableList, set.routableCount)).toBe(1);
    expect(modNLookup(4, set.routableList, set.routableCount)).toBe(3);
    expect(modNLookup(8, set.routableList, set.routableCount)).toBe(6);
    expect(modNLookup(5, set.routableList, 0)).toBe(-1);
  });
});

describe('remapping over 10k sessions, 8 replicas to 7 and back (01 §5 concept 10)', () => {
  for (const seed of [1, 42]) {
    const ring = buildRing(seed, 8, 128);

    it(`mod-N moves about 7/8 of sessions whichever replica goes (seed ${seed})`, () => {
      for (let r = 0; r < 8; r++) {
        const seven = without(ALL8, r);
        expect(Math.abs(movedFraction(seed, ring, 'modN', ALL8, seven) - 7 / 8)).toBeLessThan(0.03);
        expect(Math.abs(movedFraction(seed, ring, 'modN', seven, ALL8) - 7 / 8)).toBeLessThan(0.03);
      }
    });

    it(`consistent hashing moves about 1/8, only the lost replica's own (seed ${seed})`, () => {
      const all = routableSet(8, ALL8);
      for (let r = 0; r < 8; r++) {
        const seven = routableSet(8, without(ALL8, r));
        const gained = new Set<number>();
        let moved = 0;
        let movedFromOthers = 0;
        for (let s = 0; s < SESSIONS; s++) {
          const h = sessionHash(seed, 0, s);
          const before = affinityTarget(all, ring, 'consistent', h);
          const after = affinityTarget(seven, ring, 'consistent', h);
          if (before !== after) {
            moved++;
            if (before !== r) movedFromOthers++;
            gained.add(after);
          }
        }
        expect(movedFromOthers).toBe(0); // only the lost replica's sessions move
        expect(Math.abs(moved / SESSIONS - 1 / 8)).toBeLessThan(0.03);
        expect(gained.size).toBeGreaterThanOrEqual(5); // virtual nodes spread them over survivors
        // The rejoin moves the same sessions back.
        expect(movedFraction(seed, ring, 'consistent', without(ALL8, r), ALL8)).toBe(
          moved / SESSIONS,
        );
      }
    });
  }
});
