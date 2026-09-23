// Open sessions: one record per session that still has a request in flight or an arrival pending.
// Struct-of-arrays in typed arrays, like the request table, so checkpoints stay cheap. Records are
// reused after a session ends. Extra requests (InjectedEvent 'extraRequest') get a record too, as
// synthetic single-turn sessions, so the client logic (timeout, retries) is the same for both.
//
// Each open record is in exactly one of two phases:
// - in flight: `slot` holds its live request, and `ev` is NO_EVENT;
// - pending: `slot` is -1, and `ev` is its pending arrival-band event (next turn, retry, or extra).
// So no session ever has two outstanding requests. `timeoutEv` is armed only while in flight.

import { NO_EVENT } from '../core/index.ts';

export type SessionRecord = number;

export interface SessionTable {
  capacity: number;
  /** Open records. */
  count: number;
  free: number[];

  open: Uint8Array;
  /** Day-local session id: the candidate index, or EXTRA_SESSION_BASE + n for extra requests. */
  id: Uint32Array;
  analyst: Uint32Array;
  /** REQUEST_KIND. */
  kind: Uint8Array;
  /** Scripted turn count (1 for an extra request). */
  turns: Uint16Array;
  /** Turn of the request in flight or about to be sent; 1-based. */
  turn: Uint16Array;
  /** Attempt of that request; 0 first. */
  attempt: Uint8Array;
  /** Replica that served the previous completed turn; -1 if none. */
  prevReplica: Int8Array;
  /** System prompt, fixed for the whole session. */
  systemPrompt: Uint32Array;
  /** Message and output tokens of the session's successful turns (K8). */
  history: Uint32Array;
  /** New-message tokens of the current turn. */
  message: Uint32Array;
  /** Output target of the current turn. */
  output: Uint32Array;
  /** Workload parameters in effect at the session's start. */
  messageMedian: Float64Array;
  outputMedian: Float64Array;
  thinkMedianMs: Float64Array;
  startMs: Float64Array;
  /** Live request slot; -1 when none. */
  slot: Int32Array;
  /** Pending next-turn, retry, or extra event; NO_EVENT when none. */
  ev: Float64Array;
  /** Pending client timeout; NO_EVENT when none. */
  timeoutEv: Float64Array;
}

type Arr = Uint8Array | Int8Array | Uint16Array | Uint32Array | Int32Array | Float64Array;

const FIELDS: readonly [keyof SessionTable, (n: number) => Arr, number][] = [
  ['open', (n) => new Uint8Array(n), 0],
  ['id', (n) => new Uint32Array(n), 0],
  ['analyst', (n) => new Uint32Array(n), 0],
  ['kind', (n) => new Uint8Array(n), 0],
  ['turns', (n) => new Uint16Array(n), 0],
  ['turn', (n) => new Uint16Array(n), 0],
  ['attempt', (n) => new Uint8Array(n), 0],
  ['prevReplica', (n) => new Int8Array(n), -1],
  ['systemPrompt', (n) => new Uint32Array(n), 0],
  ['history', (n) => new Uint32Array(n), 0],
  ['message', (n) => new Uint32Array(n), 0],
  ['output', (n) => new Uint32Array(n), 0],
  ['messageMedian', (n) => new Float64Array(n), 0],
  ['outputMedian', (n) => new Float64Array(n), 0],
  ['thinkMedianMs', (n) => new Float64Array(n), 0],
  ['startMs', (n) => new Float64Array(n), NaN],
  ['slot', (n) => new Int32Array(n), -1],
  ['ev', (n) => new Float64Array(n), NO_EVENT],
  ['timeoutEv', (n) => new Float64Array(n), NO_EVENT],
];

function fields(t: SessionTable): Record<string, Arr> {
  return t as unknown as Record<string, Arr>;
}

export function createSessionTable(capacity = 256): SessionTable {
  const t = { capacity, count: 0, free: [] as number[] } as SessionTable;
  for (const [name, make, fill] of FIELDS) fields(t)[name] = make(capacity).fill(fill);
  for (let r = capacity - 1; r >= 0; r--) t.free.push(r);
  return t;
}

function grow(t: SessionTable): void {
  const old = t.capacity;
  const cap = old * 2;
  const f = fields(t);
  for (const [name, make, fill] of FIELDS) {
    const b = make(cap).fill(fill);
    b.set(f[name]!);
    f[name] = b;
  }
  for (let r = cap - 1; r >= old; r--) t.free.push(r);
  t.capacity = cap;
}

/** A cleared record, marked open. Never hold a field array across this call (it may grow them). */
export function openSession(t: SessionTable): SessionRecord {
  if (t.free.length === 0) grow(t);
  const r = t.free.pop()!;
  t.open[r] = 1;
  t.count++;
  return r;
}

/**
 * Clears the record to its FIELDS fill values and returns it to the free list. Written out field by
 * field: a loop over FIELDS is megamorphic and cost 7% of a knee day.
 */
export function closeSession(t: SessionTable, r: SessionRecord): void {
  if (t.open[r] !== 1) throw new Error(`load: session record ${r} closed twice`);
  t.open[r] = 0;
  t.id[r] = 0;
  t.analyst[r] = 0;
  t.kind[r] = 0;
  t.turns[r] = 0;
  t.turn[r] = 0;
  t.attempt[r] = 0;
  t.prevReplica[r] = -1;
  t.systemPrompt[r] = 0;
  t.history[r] = 0;
  t.message[r] = 0;
  t.output[r] = 0;
  t.messageMedian[r] = 0;
  t.outputMedian[r] = 0;
  t.thinkMedianMs[r] = 0;
  t.startMs[r] = NaN;
  t.slot[r] = -1;
  t.ev[r] = NO_EVENT;
  t.timeoutEv[r] = NO_EVENT;
  t.free.push(r);
  t.count--;
}

/** Grows an Int32Array to at least `length`, filling new entries with `fill`. */
export function growInt32(a: Int32Array, length: number, fill: number): Int32Array {
  if (a.length >= length) return a;
  const b = new Int32Array(Math.max(length, a.length * 2)).fill(fill);
  b.set(a);
  return b;
}
