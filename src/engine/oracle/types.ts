// Shapes shared by the oracle (sim.ts), the engine run it is compared with (engine-run.ts), and
// the comparison (compare.ts). Plain data only.

import type { SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { REPLICA_COUNTERS } from '../shared/index.ts';
import { lruOrder, type KvPool } from '../kv/index.ts';
import type { DayIndex } from '../time.ts';

/** One scripted request. Times are ms after the day's start. */
export interface OracleRequestSpec {
  /** Arrival time; with `after`, the delay after that request ends (any outcome). */
  atMs: number;
  /** Index of an earlier request whose end triggers this one (the next turn of a session). */
  after?: number;
  session: number;
  turn: number;
  /** Whole prompt, system prompt included. */
  promptTokens: number;
  outputTokens: number;
  systemPromptTokens: number;
  /** Client timeout to first token, ms after arrival (K8). */
  timeoutMs?: number;
  /** Cancel at this time (ms after the day's start) if still in flight, whatever its state. */
  cancelAtMs?: number;
}

/** A replica state change (E8's role): REPLICA_STATE code at a time after the day's start. */
export interface OracleReplicaChange {
  atMs: number;
  replica: number;
  state: number;
}

/** Everything one differential run needs. The same input drives the engine and the oracle. */
export interface OracleInput {
  seed: number;
  cal: Calibration;
  config: SimConfig;
  day: DayIndex;
  requests: OracleRequestSpec[];
  replicaChanges: OracleReplicaChange[];
}

/** What each request did, indexed like OracleInput.requests. NaN / -1 where it never got there. */
export interface RequestResults {
  arriveMs: number[];
  dispatchMs: number[];
  firstTokenMs: number[];
  endMs: number[];
  /** OUTCOME code, or -1 if the request never ended (or never arrived). */
  outcome: number[];
  /** Replica that held it at the end; -1 if it ended at the router. */
  replica: number[];
  cachedTokens: number[];
  preemptions: number[];
  outputDone: number[];
  /** Every requestState change as flat [atMs, REQUEST_STATE code] pairs. */
  transitions: number[][];
}

export type ReplicaCounter = (typeof REPLICA_COUNTERS)[number];

/** Cumulative replica meters at the end of the run: counter → value per replica. */
export type CounterTotals = Record<ReplicaCounter, number[]>;

/** One engine step as composed (per-step traces; a span is one record with steps > 1). */
export interface StepRecord {
  replica: number;
  /** Steps the replica completed before this one. */
  clock: number;
  atMs: number;
  durationMs: number;
  /** 1 for a single step; k for a decode-only span (engine with event-jumping only). */
  steps: number;
  decodeSeqs: number;
  decodeContextTokens: number;
  /** Prefill chunks in scheduling order: [request index, prior tokens, new tokens] triples. */
  chunks: number[];
  preempted: boolean;
}

/**
 * A replica's KV pool at the end of the run, as content: what an LRU-order or registration-order
 * difference leaves behind even when no request's outcome shows it.
 */
export interface PoolContents {
  /** Content keys of the evictable blocks, least recently used first. */
  lruKeys: number[];
  free: number;
  referenced: number;
  /** Evictions since the pool was created or last wiped. */
  evictions: number;
}

export interface RunResults {
  dayStartMs: number;
  requests: RequestResults;
  counters: CounterTotals;
  pools: PoolContents[];
  /** Composed steps in order, when tracing was asked for. */
  steps: StepRecord[];
}

export function emptyRequestResults(n: number): RequestResults {
  const nan = () => new Array<number>(n).fill(NaN);
  const neg = () => new Array<number>(n).fill(-1);
  return {
    arriveMs: nan(),
    dispatchMs: nan(),
    firstTokenMs: nan(),
    endMs: nan(),
    outcome: neg(),
    replica: neg(),
    cachedTokens: neg(),
    preemptions: neg(),
    outputDone: neg(),
    transitions: Array.from({ length: n }, () => []),
  };
}

export function emptyCounters(replicas: number): CounterTotals {
  const c = {} as CounterTotals;
  for (const k of REPLICA_COUNTERS) c[k] = new Array<number>(replicas).fill(0);
  return c;
}

export function poolContents(pool: KvPool): PoolContents {
  return {
    lruKeys: lruOrder(pool).map((b) => pool.contentKey[b]!),
    free: pool.freeCount,
    referenced: pool.referencedCount,
    evictions: pool.evictionsTotal,
  };
}
