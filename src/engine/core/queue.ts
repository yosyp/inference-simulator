// Event queue for the day runner (00-build E2; 02-simulator §4–§5).
//
// An array-backed binary min-heap ordered by (atMs, priority, sequence). It is plain data (numbers
// and typed arrays), so it checkpoints with structuredClone, and a restored copy pops in exactly the
// same order. The tie key holds a unique sequence number, so the pop order is a strict total order:
// it never depends on the heap's internal layout (growth, compaction, or clone).
//
// Cancellation is O(1) and lazy. A cancelled entry is marked in its pool slot and dropped when it
// reaches the top, or in a compaction pass once cancelled entries outnumber live ones. A handle
// carries its slot's generation, so cancelling a handle whose event already fired, was already
// cancelled, or was never scheduled (NO_EVENT) is a harmless no-op.

/** Opaque, non-negative id of a scheduled event; NO_EVENT (-1) means "nothing scheduled". */
export type EventHandle = number;
export const NO_EVENT: EventHandle = -1;

/** Largest event priority. Keeps priority × 2^32 + sequence below 2^52 (exact in a double). */
export const MAX_PRIORITY = 0xfffff;
const SEQ_SPAN = 2 ** 32;
/** Pool slots, i.e. events pending at once. Handles are generation × SLOT_SPAN + slot < 2^53. */
const SLOT_SPAN = 2 ** 21;
const CANCELLED = -1;
/** Compact once more than this many cancelled entries sit in the heap and they outnumber live ones. */
const COMPACT_MIN = 1024;

export interface EventQueue {
  capacity: number;
  /** Heap entries, including cancelled ones not yet dropped. */
  size: number;
  /** Heap entries not cancelled. */
  live: number;
  /** Next insertion sequence number; also the count of events ever pushed. */
  nextSeq: number;
  /** Pool slots ever handed out (high-water mark). */
  used: number;
  freeCount: number;
  // Heap, in heap order: time, tie key (priority × 2^32 + sequence), pool slot.
  heapAt: Float64Array;
  heapOrd: Float64Array;
  heapSlot: Int32Array;
  // Pool, by slot. kind -1 marks a cancelled entry.
  kind: Int32Array;
  a: Float64Array;
  b: Float64Array;
  /** Bumped each time the slot is freed; part of the handle. */
  gen: Uint32Array;
  /** Stack of free slots. */
  free: Int32Array;
}

/** The event being dispatched. The runner reuses one object; handlers must not keep it. */
export interface EventView {
  atMs: number;
  kind: number;
  a: number;
  b: number;
  handle: EventHandle;
}

export function createQueue(capacity = 256): EventQueue {
  const cap = Math.max(4, Math.min(SLOT_SPAN, Math.ceil(capacity)));
  return {
    capacity: cap,
    size: 0,
    live: 0,
    nextSeq: 0,
    used: 0,
    freeCount: 0,
    heapAt: new Float64Array(cap),
    heapOrd: new Float64Array(cap),
    heapSlot: new Int32Array(cap),
    kind: new Int32Array(cap),
    a: new Float64Array(cap),
    b: new Float64Array(cap),
    gen: new Uint32Array(cap),
    free: new Int32Array(cap),
  };
}

function grow(q: EventQueue): void {
  if (q.capacity >= SLOT_SPAN) {
    throw new RangeError(`Event queue full: more than ${SLOT_SPAN} events pending at once`);
  }
  const cap = Math.min(SLOT_SPAN, q.capacity * 2);
  const f64 = (src: Float64Array) => {
    const dst = new Float64Array(cap);
    dst.set(src);
    return dst;
  };
  const i32 = (src: Int32Array) => {
    const dst = new Int32Array(cap);
    dst.set(src);
    return dst;
  };
  q.heapAt = f64(q.heapAt);
  q.heapOrd = f64(q.heapOrd);
  q.heapSlot = i32(q.heapSlot);
  q.kind = i32(q.kind);
  q.a = f64(q.a);
  q.b = f64(q.b);
  const gen = new Uint32Array(cap);
  gen.set(q.gen);
  q.gen = gen;
  q.free = i32(q.free);
  q.capacity = cap;
}

function siftUp(q: EventQueue, index: number, at: number, ord: number, slot: number): void {
  const hA = q.heapAt;
  const hO = q.heapOrd;
  const hS = q.heapSlot;
  let i = index;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pa = hA[p]!;
    if (pa < at || (pa === at && hO[p]! < ord)) break;
    hA[i] = pa;
    hO[i] = hO[p]!;
    hS[i] = hS[p]!;
    i = p;
  }
  hA[i] = at;
  hO[i] = ord;
  hS[i] = slot;
}

function siftDown(q: EventQueue, index: number, at: number, ord: number, slot: number): void {
  const hA = q.heapAt;
  const hO = q.heapOrd;
  const hS = q.heapSlot;
  const n = q.size;
  const half = n >> 1;
  let i = index;
  while (i < half) {
    let c = 2 * i + 1;
    let ca = hA[c]!;
    let co = hO[c]!;
    const r = c + 1;
    if (r < n) {
      const ra = hA[r]!;
      const ro = hO[r]!;
      if (ra < ca || (ra === ca && ro < co)) {
        c = r;
        ca = ra;
        co = ro;
      }
    }
    if (at < ca || (at === ca && ord < co)) break;
    hA[i] = ca;
    hO[i] = co;
    hS[i] = hS[c]!;
    i = c;
  }
  hA[i] = at;
  hO[i] = ord;
  hS[i] = slot;
}

/** Removes the heap's top entry and returns its slot (not yet freed). */
function removeTop(q: EventQueue): number {
  const slot = q.heapSlot[0]!;
  const n = --q.size;
  if (n > 0) siftDown(q, 0, q.heapAt[n]!, q.heapOrd[n]!, q.heapSlot[n]!);
  return slot;
}

function freeSlot(q: EventQueue, slot: number): void {
  q.gen[slot] = q.gen[slot]! + 1;
  q.free[q.freeCount++] = slot;
}

function handleOf(q: EventQueue, slot: number): EventHandle {
  return q.gen[slot]! * SLOT_SPAN + slot;
}

/** Slot of a handle that is still pending, or -1. */
function pendingSlot(q: EventQueue, handle: EventHandle): number {
  if (!(handle >= 0)) return -1;
  const slot = handle % SLOT_SPAN;
  if (!(slot < q.used) || q.gen[slot] !== (handle - slot) / SLOT_SPAN) return -1;
  return q.kind[slot] === CANCELLED ? -1 : slot;
}

/**
 * Adds an event. The caller validates atMs (finite, not in the past) and kind (>= 0).
 * Ties on atMs pop by priority (lower first), then by push order.
 */
export function queuePush(
  q: EventQueue,
  atMs: number,
  priority: number,
  kind: number,
  a: number,
  b: number,
): EventHandle {
  if (q.nextSeq >= SEQ_SPAN) throw new RangeError('Event queue sequence exhausted');
  const ord = priority * SEQ_SPAN + q.nextSeq++;
  let slot: number;
  if (q.freeCount > 0) {
    slot = q.free[--q.freeCount]!;
  } else {
    if (q.used === q.capacity) grow(q);
    slot = q.used++;
  }
  q.kind[slot] = kind;
  q.a[slot] = a;
  q.b[slot] = b;
  siftUp(q, q.size++, atMs, ord, slot);
  q.live++;
  return handleOf(q, slot);
}

/** Time of the earliest pending event, or Infinity. Drops cancelled entries from the top. */
export function queuePeekAt(q: EventQueue): number {
  while (q.size > 0) {
    if (q.kind[q.heapSlot[0]!] !== CANCELLED) return q.heapAt[0]!;
    freeSlot(q, removeTop(q));
  }
  return Infinity;
}

/** Removes the earliest event into `out`. Call only after queuePeekAt returned a finite time. */
export function queueTake(q: EventQueue, out: EventView): void {
  out.atMs = q.heapAt[0]!;
  const slot = removeTop(q);
  out.kind = q.kind[slot]!;
  out.a = q.a[slot]!;
  out.b = q.b[slot]!;
  out.handle = handleOf(q, slot);
  q.live--;
  freeSlot(q, slot);
}

/** Pops the earliest pending event into `out`; false if the queue is empty. */
export function queuePop(q: EventQueue, out: EventView): boolean {
  if (queuePeekAt(q) === Infinity) return false;
  queueTake(q, out);
  return true;
}

/** Cancels a pending event in O(1). Returns false (and does nothing) if it is not pending. */
export function queueCancel(q: EventQueue, handle: EventHandle): boolean {
  const slot = pendingSlot(q, handle);
  if (slot < 0) return false;
  q.kind[slot] = CANCELLED;
  q.live--;
  const dead = q.size - q.live;
  if (dead > COMPACT_MIN && dead > q.live) compact(q);
  return true;
}

export function queueIsPending(q: EventQueue, handle: EventHandle): boolean {
  return pendingSlot(q, handle) >= 0;
}

/** Drops every cancelled entry and re-heapifies (Floyd). Pop order is unchanged. */
function compact(q: EventQueue): void {
  let n = 0;
  for (let i = 0; i < q.size; i++) {
    const slot = q.heapSlot[i]!;
    if (q.kind[slot] === CANCELLED) {
      freeSlot(q, slot);
      continue;
    }
    q.heapAt[n] = q.heapAt[i]!;
    q.heapOrd[n] = q.heapOrd[i]!;
    q.heapSlot[n] = slot;
    n++;
  }
  q.size = n;
  for (let i = (n >> 1) - 1; i >= 0; i--) {
    siftDown(q, i, q.heapAt[i]!, q.heapOrd[i]!, q.heapSlot[i]!);
  }
}

/** Earliest live event time without mutating the queue (O(n); for invariant checks). */
export function queueMinLiveAt(q: EventQueue): number {
  let min = Infinity;
  for (let i = 0; i < q.size; i++) {
    if (q.kind[q.heapSlot[i]!] !== CANCELLED && q.heapAt[i]! < min) min = q.heapAt[i]!;
  }
  return min;
}

/** Latest live event time without mutating the queue (O(n); for invariant checks). */
export function queueMaxLiveAt(q: EventQueue): number {
  let max = -Infinity;
  for (let i = 0; i < q.size; i++) {
    if (q.kind[q.heapSlot[i]!] !== CANCELLED && q.heapAt[i]! > max) max = q.heapAt[i]!;
  }
  return max;
}

/** Throws if the heap order, counts, or slot bookkeeping is broken (O(n)). */
export function assertQueue(q: EventQueue): void {
  const fail = (msg: string): never => {
    throw new Error(`Event queue invariant: ${msg}`);
  };
  if (q.size < 0 || q.size > q.capacity) fail(`size ${q.size} outside [0, ${q.capacity}]`);
  if (q.used - q.freeCount !== q.size) {
    fail(`slots in use ${q.used - q.freeCount} != heap size ${q.size}`);
  }
  let live = 0;
  const seen = new Uint8Array(q.used);
  for (let i = 0; i < q.size; i++) {
    const slot = q.heapSlot[i]!;
    if (slot < 0 || slot >= q.used || seen[slot]) fail(`bad or repeated slot ${slot} at ${i}`);
    seen[slot] = 1;
    if (q.kind[slot] !== CANCELLED) live++;
    if (i > 0) {
      const p = (i - 1) >> 1;
      const pa = q.heapAt[p]!;
      const ca = q.heapAt[i]!;
      if (pa > ca || (pa === ca && q.heapOrd[p]! >= q.heapOrd[i]!)) fail(`heap order at ${i}`);
    }
  }
  for (let i = 0; i < q.freeCount; i++) {
    const slot = q.free[i]!;
    if (slot < 0 || slot >= q.used || seen[slot]) fail(`free slot ${slot} also in use`);
    seen[slot] = 1;
  }
  if (live !== q.live) fail(`live count ${q.live} != ${live}`);
}
