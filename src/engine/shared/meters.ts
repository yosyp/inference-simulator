// Shared meters (docs/00-build.md §4): counters and levels that E9 turns into ScalarBlock metrics.
// E9 observes most request counts itself through topics; meters hold what only the owner can see.
//
// Ownership:
// - E5 replica: every ReplicaMeters counter, plus the kvUsed, running, and waiting levels. At each
//   bucket end, E5's onBucketEnd pro-rates any step in progress into the counters, so E9 (later in
//   module order) reads values exact to the boundary.
// - E7 router: the outstanding levels.
// - E6 client: fleet.abandonedSessions.
// Counters are cumulative since the day's start; E9 diffs them at bucket ends and takes level means.

import { createLevel, type Level } from '../core/level.ts';
import type { SimMs } from '../time.ts';

export interface ReplicaMeters {
  prefillTokens: Float64Array;
  recomputedPrefillTokens: Float64Array;
  decodeTokens: Float64Array;
  /** nvidia-smi-style busy time: whole steps including t_o (E3). */
  busyMs: Float64Array;
  flops: Float64Array;
  preemptions: Float64Array;
  evictedBlocks: Float64Array;
  prefixQueryTokens: Float64Array;
  prefixHitTokens: Float64Array;
  /** Prefix lookups for turns >= 2 only (tab 4). */
  returningQueryTokens: Float64Array;
  returningHitTokens: Float64Array;
  /** Levels, one per replica. kvUsed is the referenced-block fraction (E4 kvUsedFrac). */
  kvUsed: Level[];
  running: Level[];
  waiting: Level[];
  /** Router-tracked dispatched-and-not-ended count (E7). */
  outstanding: Level[];
}

export interface FleetMeters {
  abandonedSessions: number;
}

export interface Meters {
  replica: ReplicaMeters;
  fleet: FleetMeters;
}

export const REPLICA_COUNTERS = [
  'prefillTokens',
  'recomputedPrefillTokens',
  'decodeTokens',
  'busyMs',
  'flops',
  'preemptions',
  'evictedBlocks',
  'prefixQueryTokens',
  'prefixHitTokens',
  'returningQueryTokens',
  'returningHitTokens',
] as const satisfies readonly (keyof ReplicaMeters)[];

export function createMeters(replicas: number, atMs: SimMs): Meters {
  const levels = () => Array.from({ length: replicas }, () => createLevel(atMs));
  const replica = {
    kvUsed: levels(),
    running: levels(),
    waiting: levels(),
    outstanding: levels(),
  } as ReplicaMeters;
  for (const c of REPLICA_COUNTERS) replica[c] = new Float64Array(replicas);
  return { replica, fleet: { abandonedSessions: 0 } };
}
