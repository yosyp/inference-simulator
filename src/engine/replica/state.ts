// The replica slice (WP E5): per-replica scheduler state and per-request engine state, as plain
// data so checkpoints clone it. See index.ts for the scheduling rules and the event-jumping plan.

import type { SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { NO_EVENT, type EventHandle } from '../core/index.ts';
import { emptyDecodeSpan, emptyStepDesc, type DecodeSpan, type StepDesc } from '../cost/index.ts';
import { createMorningKvPool, type KvPool } from '../kv/index.ts';
import { REPLICA_STATE } from '../results.ts';

/** Event kinds (replica range 300-399). */
export const EV_STEP_END = 300;
export const EV_KICK = 301;
/** A dispatched request's request overhead has passed: it joins the waiting queue. */
export const EV_ELIGIBLE = 302;

/**
 * Where a request is inside the replica that holds it. `arriving`: dispatched, waiting out the
 * calibration's requestOverheadMs (HTTP, tokenization) before the scheduler can see it.
 */
export const PHASE = { none: 0, waiting: 1, prefill: 2, decode: 3, arriving: 4 } as const;

/** What a replica's pending event means. */
export const MODE = {
  /** Nothing held, nothing pending. */
  idle: 0,
  /** Work arrived while idle; a kick event at the same instant composes the first step. */
  kick: 1,
  /** One step in flight; its end event is pending. */
  step: 2,
  /** A decode-only span of spanSteps steps in flight (event-jumping, 02 §5). */
  span: 3,
} as const;

/** calibration.engine with config.engineOverrides applied. */
export interface EngineLimits {
  kvPoolTokens: number;
  blockSize: number;
  maxNumSeqs: number;
  maxNumBatchedTokens: number;
  maxModelLen: number;
}

export interface ReplicaEngine {
  /** REPLICA_STATE code. */
  state: number;
  pool: KvPool;
  /** Requests in PHASE.arriving, in dispatch order (so in eligibility order). */
  arriving: number[];
  /** FIFO; waiting[waitHead ..] are queued. Preempted requests go to the front. */
  waiting: number[];
  waitHead: number;
  /** Running requests (prefill or decode phase) in admission order; the tail is the most recent. */
  running: number[];
  /** Running requests in prefill phase. */
  prefillCount: number;
  /**
   * Decode-phase requests by block residue, each in admission order. A decode request with
   * decodeBase b needs a new block at the start of the step with clock c when (b + c) % blockSize
   * is 0, and fills a block at the end of the step with clock c when (b + c + 1) % blockSize is 0.
   * Both are group[(-b) mod blockSize], read at c % blockSize and (c + 1) % blockSize.
   */
  groups: number[][];
  /** Steps completed (materialized) since the day started. */
  clock: number;
  /**
   * E3 aggregates for the step in flight. The decode fields are running totals over the
   * decode-phase requests: decodeContextTokens = Σ (decodeBase + clock + 1). The prefill fields
   * describe the current step's chunks.
   */
  desc: StepDesc;
  mode: number;
  /** The pending kick or step-end event. NO_EVENT when idle or when the end falls after the day. */
  ev: EventHandle;
  /** Start and end of the step or span in flight. */
  t0: number;
  t1: number;
  /** The current step's prefill chunks, in scheduling order. A cancelled request's slot is -1. */
  chunkSlot: number[];
  chunkPrior: number[];
  chunkTokens: number[];
  /** Totals of the single step in flight (mode step). */
  stepMs: number;
  stepFlops: number;
  stepDecode: number;
  stepPrefill: number;
  stepRecomputed: number;
  /** The span in flight (mode span): its closed form, planned steps, and steps materialized. */
  span: DecodeSpan;
  spanSteps: number;
  spanDone: number;
  /** Amounts of the step or span in flight already added to the meters. */
  acctBusy: number;
  acctFlops: number;
  acctDecode: number;
  acctPrefill: number;
  acctRecomputed: number;
}

/** Engine state per request, indexed by RequestSlot. Valid while phase is not none. */
export interface RequestEngine {
  capacity: number;
  phase: Uint8Array;
  replica: Int16Array;
  /** Blocks held: blocks[s][0 .. held). */
  held: Int32Array;
  /** Leading blocks that have been through registration (E4 registerFullBlocks). */
  registered: Int32Array;
  /** Prefill phase: tokens whose KV exists (cache hits plus completed chunks). */
  computed: Float64Array;
  /** Tokens this admission must prefill: the prompt, plus output so far after a preemption. */
  target: Float64Array;
  /** Output tokens generated before the current admission (waiting and prefill phases). */
  generated: Float64Array;
  /** Decode phase: computed tokens = decodeBase + replica clock. */
  decodeBase: Float64Array;
  /** Decode phase: the clock of the step at whose end the request finishes. */
  finishClock: Float64Array;
  /** Order of the latest admission; running lists and groups are sorted by it. */
  admitSeq: Float64Array;
  /** Prefix-cache hit tokens at the latest admission. */
  hitTokens: Float64Array;
  /** Most tokens whose KV existed before any preemption: prefill below it is recompute. */
  highWater: Float64Array;
  /** Arriving phase: the EV_ELIGIBLE handle (NO_EVENT if it falls after the day). */
  eligibleEv: Float64Array;
  blocks: number[][];
}

export interface ReplicaSlice {
  limits: EngineLimits;
  replicas: ReplicaEngine[];
  req: RequestEngine;
  nextAdmitSeq: number;
}

declare module '../core/types.ts' {
  interface DayState {
    replica: ReplicaSlice;
  }
}

export function engineLimits(config: SimConfig, cal: Calibration): EngineLimits {
  const e = cal.engine;
  const o = config.engineOverrides;
  const limits: EngineLimits = {
    kvPoolTokens: e.kvPoolTokens,
    blockSize: e.blockSize,
    maxNumSeqs: o.maxNumSeqs ?? e.maxNumSeqs,
    maxNumBatchedTokens: o.maxNumBatchedTokens ?? e.maxNumBatchedTokens,
    maxModelLen: e.maxModelLen,
  };
  for (const k of ['maxNumSeqs', 'maxNumBatchedTokens', 'maxModelLen'] as const) {
    if (!(Number.isInteger(limits[k]) && limits[k] >= 1)) {
      throw new RangeError(`Engine ${k} ${limits[k]} must be a positive integer`);
    }
  }
  // vLLM refuses max_num_batched_tokens < max_num_seqs; decodes-first relies on it too.
  if (limits.maxNumBatchedTokens < limits.maxNumSeqs) {
    throw new RangeError(
      `maxNumBatchedTokens ${limits.maxNumBatchedTokens} is below maxNumSeqs ${limits.maxNumSeqs}`,
    );
  }
  return limits;
}

export function createReplicaEngine(limits: EngineLimits, pool: KvPool): ReplicaEngine {
  return {
    state: REPLICA_STATE.ready,
    pool,
    arriving: [],
    waiting: [],
    waitHead: 0,
    running: [],
    prefillCount: 0,
    groups: Array.from({ length: limits.blockSize }, () => [] as number[]),
    clock: 0,
    desc: emptyStepDesc(),
    mode: MODE.idle,
    ev: NO_EVENT,
    t0: 0,
    t1: 0,
    chunkSlot: [],
    chunkPrior: [],
    chunkTokens: [],
    stepMs: 0,
    stepFlops: 0,
    stepDecode: 0,
    stepPrefill: 0,
    stepRecomputed: 0,
    span: emptyDecodeSpan(),
    spanSteps: 0,
    spanDone: 0,
    acctBusy: 0,
    acctFlops: 0,
    acctDecode: 0,
    acctPrefill: 0,
    acctRecomputed: 0,
  };
}

const F64 = [
  'computed',
  'target',
  'generated',
  'decodeBase',
  'finishClock',
  'admitSeq',
  'hitTokens',
  'highWater',
  'eligibleEv',
] as const;

export function createRequestEngine(capacity: number): RequestEngine {
  const q = {
    capacity,
    phase: new Uint8Array(capacity),
    replica: new Int16Array(capacity).fill(-1),
    held: new Int32Array(capacity),
    registered: new Int32Array(capacity),
    blocks: Array.from({ length: capacity }, () => [] as number[]),
  } as RequestEngine;
  for (const f of F64) q[f] = new Float64Array(capacity);
  return q;
}

/** Grows the per-request arrays to at least `capacity` (the request table's). */
export function ensureRequestCapacity(q: RequestEngine, capacity: number): void {
  if (capacity <= q.capacity) return;
  let cap = q.capacity;
  while (cap < capacity) cap *= 2;
  const phase = new Uint8Array(cap);
  phase.set(q.phase);
  q.phase = phase;
  const replica = new Int16Array(cap).fill(-1);
  replica.set(q.replica);
  q.replica = replica;
  const held = new Int32Array(cap);
  held.set(q.held);
  q.held = held;
  const registered = new Int32Array(cap);
  registered.set(q.registered);
  q.registered = registered;
  for (const f of F64) {
    const a = new Float64Array(cap);
    a.set(q[f]);
    q[f] = a;
  }
  for (let s = q.capacity; s < cap; s++) q.blocks.push([]);
  q.capacity = cap;
}

/** The standard morning state (K21): every replica Ready with only the system prompt cached. */
export function createReplicaSlice(
  config: SimConfig,
  cal: Calibration,
  systemPromptTokens: number,
  requestCapacity: number,
): ReplicaSlice {
  const limits = engineLimits(config, cal);
  const replicas: ReplicaEngine[] = [];
  for (let r = 0; r < config.replicas; r++) {
    replicas.push(createReplicaEngine(limits, createMorningKvPool(limits, systemPromptTokens)));
  }
  return {
    limits,
    replicas,
    req: createRequestEngine(Math.max(1, requestCapacity)),
    nextAdmitSeq: 0,
  };
}

export function waitingCount(rep: ReplicaEngine): number {
  return rep.waiting.length - rep.waitHead;
}

/** Non-negative remainder. */
export function mod(x: number, m: number): number {
  const v = x % m;
  return v < 0 ? v + m : v;
}

/** The group a decode request with this base belongs to. */
export function groupKey(decodeBase: number, blockSize: number): number {
  return mod(-decodeBase, blockSize);
}
