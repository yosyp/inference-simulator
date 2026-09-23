// Session hashing for affinity routing (02 §7; 01 §5 concept 10). Pure functions of plain data, so
// the router module, the tests, and E10's oracle share them.
//
// - A session's hash is a keyed E1 draw on its stable id: u32(seed, sessionHash, day, session). It
//   is the same under every policy and in every fork, so affinity comparisons stay paired (K6).
// - Mod-N indexes the ascending list of routable replicas with hash mod count. Removing one of 8
//   replicas changes the count and the list, so about 7/8 of sessions move.
// - Consistent hashing places `virtualNodesPerReplica` points per replica on a 32-bit ring, keyed
//   by (replica, virtual node). A session belongs to the first point at or after its hash,
//   clockwise; an unroutable owner falls through to the next point. Removing a replica moves only
//   its own sessions (about 1/8 of 8), and its rejoin takes back exactly those.

import type { HashScheme, ReplicaId, SessionId } from '../api.ts';
import { Source, u32 } from '../rng/index.ts';
import type { DayIndex } from '../time.ts';

/** Ring points in ascending position; ties between positions are ordered by (replica, vnode). */
export interface HashRing {
  pos: Uint32Array;
  owner: Uint16Array;
}

/** The routable replicas as the router sees them. */
export interface RoutableSet {
  /** 1 if replica r is routable. */
  routable: Uint8Array;
  /** Routable replica ids, ascending; the first `routableCount` entries are valid. */
  routableList: Int32Array;
  routableCount: number;
}

/** A session's 32-bit hash: a keyed draw on its stable, day-local id. */
export function sessionHash(seed: number, day: DayIndex, session: SessionId): number {
  return u32(seed, Source.sessionHash, day, session);
}

/** Position of one virtual node on the ring. */
export function ringPosition(seed: number, replica: ReplicaId, vnode: number): number {
  return u32(seed, Source.hashRing, replica, vnode);
}

/** The ring for `replicas` replicas with `virtualNodesPerReplica` points each (at least 1). */
export function buildRing(
  seed: number,
  replicas: number,
  virtualNodesPerReplica: number,
): HashRing {
  const v = Math.max(1, Math.floor(virtualNodesPerReplica));
  const n = replicas * v;
  const raw = new Float64Array(n);
  const order = new Array<number>(n);
  for (let r = 0; r < replicas; r++) {
    for (let k = 0; k < v; k++) {
      raw[r * v + k] = ringPosition(seed, r, k);
      order[r * v + k] = r * v + k;
    }
  }
  // Index order is (replica, vnode), so it breaks position ties deterministically.
  order.sort((x, y) => raw[x]! - raw[y]! || x - y);
  const pos = new Uint32Array(n);
  const owner = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    pos[i] = raw[order[i]!]!;
    owner[i] = Math.floor(order[i]! / v);
  }
  return { pos, owner };
}

/** Index of the first ring point at or after `hash`, wrapping to 0 past the last point. */
export function ringSuccessor(ring: HashRing, hash: number): number {
  const pos = ring.pos;
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pos[mid]! < hash) lo = mid + 1;
    else hi = mid;
  }
  return lo === pos.length ? 0 : lo;
}

/** Consistent-hash owner of `hash` among routable replicas, or -1 if none is routable. */
export function ringLookup(ring: HashRing, hash: number, routable: Uint8Array): ReplicaId {
  const n = ring.pos.length;
  let i = ringSuccessor(ring, hash);
  for (let step = 0; step < n; step++) {
    const r = ring.owner[i]!;
    if (routable[r] === 1) return r;
    i = i + 1 === n ? 0 : i + 1;
  }
  return -1;
}

/** Mod-N owner of `hash`: the (hash mod count)-th routable replica, or -1 if none is routable. */
export function modNLookup(
  hash: number,
  routableList: Int32Array,
  routableCount: number,
): ReplicaId {
  return routableCount === 0 ? -1 : routableList[hash % routableCount]!;
}

/** The replica session affinity sends `hash` to under `scheme`, or -1 if none is routable. */
export function affinityTarget(
  set: RoutableSet,
  ring: HashRing,
  scheme: HashScheme,
  hash: number,
): ReplicaId {
  return scheme === 'modN'
    ? modNLookup(hash, set.routableList, set.routableCount)
    : ringLookup(ring, hash, set.routable);
}

/** A routable set over `replicas` replicas with the given ones routable (tests, the oracle). */
export function routableSet(replicas: number, routableIds: Iterable<ReplicaId>): RoutableSet {
  const routable = new Uint8Array(replicas);
  for (const r of routableIds) routable[r] = 1;
  const set: RoutableSet = { routable, routableList: new Int32Array(replicas), routableCount: 0 };
  rebuildRoutableList(set);
  return set;
}

/** Recomputes routableList and routableCount from routable. */
export function rebuildRoutableList(set: RoutableSet): void {
  let c = 0;
  for (let r = 0; r < set.routable.length; r++)
    if (set.routable[r] === 1) set.routableList[c++] = r;
  for (let i = c; i < set.routableList.length; i++) set.routableList[i] = -1;
  set.routableCount = c;
}
