// The shared request table (docs/00-build.md §4). Integrator-owned contract for E5, E6, E7, E9.
//
// One slot per live request, struct-of-arrays in typed arrays, so it checkpoints cheaply and only
// holds requests in flight (thousands, not the day's hundreds of thousands). Topics pass the slot
// (RequestSlot); results use the stable day-local `id`.
//
// Field ownership (write only your own fields; read anything):
// - E6 load/client, at creation: id is assigned by allocRequest; session, analyst, turn, attempt,
//   kind, arriveMs, promptTokens, systemPromptTokens, outputTarget, prevReplica. It then sets
//   state = atRouter and notifies requestArrived.
// - E7 router: dispatchMs, replica.
// - E5 replica: firstTokenMs, cachedTokens, outputDone, preemptions.
// - Whoever ends a request (E7 on reject or cancel before dispatch, E5 otherwise) sets endMs,
//   outcome, and state, then notifies requestEnded.
// - Every module that changes `state` notifies requestState.
//
// Slot reuse: after requestEnded, the shared module queues the slot, and allocRequest frees queued
// slots before it allocates. So never allocate inside a notice handler: schedule an event instead
// (a retry with zero backoff is an event at nowMs). That guarantees every requestEnded subscriber
// has read the slot before it is reused.
//
// Growth replaces the arrays: never hold a field array across a call to allocRequest.

import { REQUEST_STATE } from '../results.ts';

/** Index into the request table; valid from allocRequest until the slot is reused. */
export type RequestSlot = number;

export const REQUEST_KIND = { turn: 0, extra: 1 } as const;

/** outcome before the request ends. OUTCOME codes (results.ts) are nonzero. */
export const OUTCOME_PENDING = 0;

export interface RequestTable {
  capacity: number;
  /** Next day-local request id. */
  nextId: number;
  /** Slots in use. */
  liveCount: number;
  freeSlots: number[];
  /** Ended slots waiting to be freed at the next allocRequest. */
  pendingFree: number[];

  live: Uint8Array;
  id: Uint32Array;
  session: Uint32Array;
  analyst: Uint32Array;
  /** 1-based turn within the session; 1 for extra requests. */
  turn: Uint16Array;
  /** 0 for the first attempt. */
  attempt: Uint8Array;
  kind: Uint8Array;
  /** REQUEST_STATE. */
  state: Uint8Array;
  /** -1 until dispatched. */
  replica: Int8Array;
  /** Replica that served the session's previous completed turn; -1 if none. */
  prevReplica: Int8Array;
  arriveMs: Float64Array;
  dispatchMs: Float64Array;
  firstTokenMs: Float64Array;
  endMs: Float64Array;
  /** Whole prompt: system prompt + conversation history + new message. */
  promptTokens: Uint32Array;
  /** System prompt length in effect when the request's session started (E6 freezes it per session, so KV block identity stays stable, E4). */
  systemPromptTokens: Uint32Array;
  /** Tokens the simulator will generate (known to the simulator, not the router, 02 §1). */
  outputTarget: Uint32Array;
  /** Tokens generated when the request ended. */
  outputDone: Uint32Array;
  /** Prompt tokens served from the prefix cache at the (last) admission. */
  cachedTokens: Uint32Array;
  preemptions: Uint16Array;
  /** OUTCOME code, or OUTCOME_PENDING. */
  outcome: Uint8Array;
}

const U8 = ['live', 'attempt', 'kind', 'state', 'outcome'] as const;
const I8 = ['replica', 'prevReplica'] as const;
const U16 = ['turn', 'preemptions'] as const;
const U32 = [
  'id',
  'session',
  'analyst',
  'promptTokens',
  'systemPromptTokens',
  'outputTarget',
  'outputDone',
  'cachedTokens',
] as const;
const F64 = ['arriveMs', 'dispatchMs', 'firstTokenMs', 'endMs'] as const;

export function createRequestTable(capacity = 1024): RequestTable {
  const t = {
    capacity,
    nextId: 0,
    liveCount: 0,
    freeSlots: [] as number[],
    pendingFree: [] as number[],
  } as RequestTable;
  for (const f of U8) t[f] = new Uint8Array(capacity);
  for (const f of I8) t[f] = new Int8Array(capacity).fill(-1);
  for (const f of U16) t[f] = new Uint16Array(capacity);
  for (const f of U32) t[f] = new Uint32Array(capacity);
  for (const f of F64) t[f] = new Float64Array(capacity).fill(NaN);
  for (let i = capacity - 1; i >= 0; i--) t.freeSlots.push(i);
  return t;
}

function grow(t: RequestTable): void {
  const old = t.capacity;
  const cap = old * 2;
  const copy = <A extends Uint8Array | Int8Array | Uint16Array | Uint32Array | Float64Array>(
    a: A,
    make: (n: number) => A,
    fill?: number,
  ): A => {
    const b = make(cap);
    if (fill !== undefined) b.fill(fill);
    b.set(a);
    return b;
  };
  for (const f of U8) t[f] = copy(t[f], (n) => new Uint8Array(n));
  for (const f of I8) t[f] = copy(t[f], (n) => new Int8Array(n), -1);
  for (const f of U16) t[f] = copy(t[f], (n) => new Uint16Array(n));
  for (const f of U32) t[f] = copy(t[f], (n) => new Uint32Array(n));
  for (const f of F64) t[f] = copy(t[f], (n) => new Float64Array(n), NaN);
  for (let i = cap - 1; i >= old; i--) t.freeSlots.push(i);
  t.capacity = cap;
}

// Written out field by field: a generic loop over the field lists cost ~3.5% of a knee day (E6).
function clearSlot(t: RequestTable, s: RequestSlot): void {
  t.live[s] = 0;
  t.attempt[s] = 0;
  t.kind[s] = 0;
  t.state[s] = 0;
  t.outcome[s] = 0;
  t.replica[s] = -1;
  t.prevReplica[s] = -1;
  t.turn[s] = 0;
  t.preemptions[s] = 0;
  t.id[s] = 0;
  t.session[s] = 0;
  t.analyst[s] = 0;
  t.promptTokens[s] = 0;
  t.systemPromptTokens[s] = 0;
  t.outputTarget[s] = 0;
  t.outputDone[s] = 0;
  t.cachedTokens[s] = 0;
  t.arriveMs[s] = NaN;
  t.dispatchMs[s] = NaN;
  t.firstTokenMs[s] = NaN;
  t.endMs[s] = NaN;
}

/**
 * A fresh slot with a new day-local id, state atRouter, everything else cleared. Frees slots ended
 * earlier first. Never call from a notice handler (see the file header).
 */
export function allocRequest(t: RequestTable): RequestSlot {
  while (t.pendingFree.length > 0) {
    const s = t.pendingFree.pop()!;
    clearSlot(t, s);
    t.freeSlots.push(s);
    t.liveCount--;
  }
  if (t.freeSlots.length === 0) grow(t);
  const s = t.freeSlots.pop()!;
  t.live[s] = 1;
  t.id[s] = t.nextId++;
  t.state[s] = REQUEST_STATE.atRouter;
  t.liveCount++;
  return s;
}

/** Queues an ended slot for reuse. Called by the shared module's requestEnded subscriber. */
export function releaseRequest(t: RequestTable, s: RequestSlot): void {
  if (t.live[s] !== 1) throw new Error(`Request slot ${s} released twice or never allocated`);
  t.live[s] = 2;
  t.pendingFree.push(s);
}

export function isLive(t: RequestTable, s: RequestSlot): boolean {
  return t.live[s] === 1;
}

export function assertRequestTable(t: RequestTable): void {
  let live = 0;
  for (let s = 0; s < t.capacity; s++) if (t.live[s] !== 0) live++;
  if (live !== t.liveCount)
    throw new Error(`Request table: liveCount ${t.liveCount}, found ${live}`);
  if (live + t.freeSlots.length !== t.capacity) {
    throw new Error('Request table: live + free slots != capacity');
  }
}
