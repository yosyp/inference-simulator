// The five routing policies (02 §7) as a pure choice over what the router sees. Load-aware
// policies read the sampled signals (seenOutstanding, seenKv), never live values, so a burst inside
// one refresh interval piles onto the replica that looked idle (01 §5 concept 6).
//
// Ties between equally good replicas go to a keyed uniform (routingTieBreak), picking uniformly
// among the tied replicas in ascending id order.

import type { ReplicaId, TunableParams } from '../api.ts';
import { affinityTarget, type HashRing, type RoutableSet } from './hash.ts';

export type RoutingParams = Pick<
  TunableParams,
  'routingPolicy' | 'hashScheme' | 'weightAffinity' | 'weightOutstanding' | 'weightKv'
>;

/** Everything a routing choice reads. The router's slice extends it. */
export interface RoutingView extends RoutableSet {
  ring: HashRing;
  /** Outstanding count per replica at the last signal refresh. */
  seenOutstanding: Float64Array;
  /** KV used fraction per replica at the last signal refresh. */
  seenKv: Float64Array;
  /** Replica round-robin chose last; -1 before the first choice. */
  rrLast: number;
}

/** Whether the policy needs the session hash, so callers draw it only when used. */
export function policyUsesHash(p: RoutingParams): boolean {
  return p.routingPolicy === 'sessionAffinity' || p.routingPolicy === 'weighted';
}

/** Whether the policy can tie, so callers draw the tie-break uniform only when used. */
export function policyCanTie(p: RoutingParams): boolean {
  return (
    p.routingPolicy === 'leastOutstanding' ||
    p.routingPolicy === 'kvUtilization' ||
    p.routingPolicy === 'weighted'
  );
}

/**
 * The replica to send a request to, or -1 if none is routable. `hash` is the session hash
 * (sessionHash) and `tieU` a uniform in [0, 1) for tie-breaks; either may be 0 when the policy
 * doesn't use it. Pure: the caller advances rrLast after a round-robin choice.
 */
export function chooseReplica(
  view: RoutingView,
  p: RoutingParams,
  hash: number,
  tieU: number,
): ReplicaId {
  if (view.routableCount === 0) return -1;
  switch (p.routingPolicy) {
    case 'roundRobin':
      return nextRoundRobin(view);
    case 'leastOutstanding':
      return pickLowest(view, view.seenOutstanding, tieU);
    case 'kvUtilization':
      return pickLowest(view, view.seenKv, tieU);
    case 'sessionAffinity':
      return affinityTarget(view, view.ring, p.hashScheme, hash);
    case 'weighted':
      return pickWeighted(view, p, affinityTarget(view, view.ring, p.hashScheme, hash), tieU);
  }
}

/** The first routable replica after rrLast, cycling in id order. */
export function nextRoundRobin(view: RoutingView): ReplicaId {
  const list = view.routableList;
  for (let i = 0; i < view.routableCount; i++) if (list[i]! > view.rrLast) return list[i]!;
  return view.routableCount > 0 ? list[0]! : -1;
}

/** The routable replica with the lowest value; ties broken by tieU. */
export function pickLowest(view: RoutableSet, values: Float64Array, tieU: number): ReplicaId {
  const list = view.routableList;
  let best = Infinity;
  let ties = 0;
  let first = -1;
  for (let i = 0; i < view.routableCount; i++) {
    const v = values[list[i]!]!;
    if (v < best) {
      best = v;
      ties = 1;
      first = list[i]!;
    } else if (v === best) {
      ties++;
    }
  }
  if (ties <= 1) return first;
  let k = tieIndex(tieU, ties);
  for (let i = 0; i < view.routableCount; i++) {
    if (values[list[i]!] === best && k-- === 0) return list[i]!;
  }
  return first;
}

/** Largest sampled outstanding count among routable replicas (0 if all idle). */
export function maxSeenOutstanding(view: RoutingView): number {
  let max = 0;
  for (let i = 0; i < view.routableCount; i++) {
    const v = view.seenOutstanding[view.routableList[i]!]!;
    if (v > max) max = v;
  }
  return max;
}

/**
 * Weighted score of replica r: weightAffinity × [r is the affinity target] − weightOutstanding ×
 * (sampled outstanding ÷ the largest sampled outstanding among routable replicas, 0 if all idle) −
 * weightKv × sampled KV fraction. Both load terms lie in [0, 1], so the weights compare directly.
 */
export function weightedScore(
  view: RoutingView,
  p: RoutingParams,
  r: ReplicaId,
  target: ReplicaId,
  maxOutstanding: number,
): number {
  const norm = maxOutstanding > 0 ? view.seenOutstanding[r]! / maxOutstanding : 0;
  return (
    (r === target ? p.weightAffinity : 0) -
    p.weightOutstanding * norm -
    p.weightKv * view.seenKv[r]!
  );
}

/** The routable replica with the highest weighted score; ties broken by tieU. */
export function pickWeighted(
  view: RoutingView,
  p: RoutingParams,
  target: ReplicaId,
  tieU: number,
): ReplicaId {
  const list = view.routableList;
  const maxOut = maxSeenOutstanding(view);
  let best = -Infinity;
  let ties = 0;
  let first = -1;
  for (let i = 0; i < view.routableCount; i++) {
    const s = weightedScore(view, p, list[i]!, target, maxOut);
    if (s > best) {
      best = s;
      ties = 1;
      first = list[i]!;
    } else if (s === best) {
      ties++;
    }
  }
  if (ties <= 1) return first;
  let k = tieIndex(tieU, ties);
  for (let i = 0; i < view.routableCount; i++) {
    if (weightedScore(view, p, list[i]!, target, maxOut) === best && k-- === 0) return list[i]!;
  }
  return first;
}

function tieIndex(u: number, ties: number): number {
  return Math.min(ties - 1, Math.floor(u * ties));
}
