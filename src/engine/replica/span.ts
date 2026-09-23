// Event-jumping (02 §5): a decode-only span of k steps runs as one event. Its effects on requests
// and the KV pool are applied lazily, step by step in exactly the per-step order, whenever someone
// needs the state at a time inside the span (a truncation, a bucket end, the span's end). The
// meters accrue the step or span in flight pro rata, exact to any time.

import type { Ctx, DayState } from '../core/index.ts';
import { setLevel } from '../core/index.ts';
import {
  decodeSpanDurationMs,
  decodeSpanFlops,
  decodeSpanStepMs,
  decodeSpanStepsWithin,
} from '../cost/index.ts';
import { allocateBlocks, availableBlocks, kvUsedFrac, registerFullBlocks } from '../kv/index.ts';
import { MODE, type ReplicaEngine } from './state.ts';

/** Registers the blocks filled by the decode step with clock rep.clock, then advances the clock. */
export function endDecodeStep(state: DayState, rep: ReplicaEngine): void {
  const q = state.replica.req;
  const t = state.shared.requests;
  const bs = rep.pool.blockSize;
  const c = rep.clock;
  const group = rep.groups[(c + 1) % bs]!;
  for (let i = 0; i < group.length; i++) {
    const s = group[i]!;
    q.registered[s] = registerFullBlocks(
      rep.pool,
      t.session[s]!,
      t.systemPromptTokens[s]!,
      q.blocks[s]!,
      0,
      q.registered[s]!,
      q.decodeBase[s]! + c + 1,
    );
  }
  rep.clock = c + 1;
  rep.desc.decodeContextTokens += rep.desc.decodeSeqs;
}

/**
 * Allocates the blocks the decode step with clock rep.clock needs inside a span, where the plan
 * guarantees they fit. Counts evictions and moves the KV level at the step's start.
 */
function startSpanStep(state: DayState, rep: ReplicaEngine, r: number, atMs: number): void {
  const q = state.replica.req;
  const group = rep.groups[rep.clock % rep.pool.blockSize]!;
  if (group.length === 0) return;
  const meters = state.shared.meters.replica;
  let evicted = 0;
  for (let i = 0; i < group.length; i++) {
    const s = group[i]!;
    if (!allocateBlocks(rep.pool, 1, q.blocks[s]!, q.held[s]!)) {
      throw new Error(`replica ${r}: a planned span step ran out of KV blocks`);
    }
    q.held[s] = q.held[s]! + 1;
    evicted += rep.pool.evictedCount;
  }
  if (evicted > 0) meters.evictedBlocks[r] = meters.evictedBlocks[r]! + evicted;
  const level = meters.kvUsed[r]!;
  // Lazy steps must be applied before anything moves the level past them (see syncLevels).
  if (level.sinceMs - atMs > 1e-6)
    throw new Error(`replica ${r}: KV level moved before a span step`);
  setLevel(level, Math.max(level.sinceMs, atMs), kvUsedFrac(rep.pool));
}

/**
 * Brings a span's state up to time T: completes every step that ended by T (except the last,
 * which the step-end handler completes) and allocates for the step in flight at T.
 */
export function syncSpan(state: DayState, r: number, T: number): void {
  const rep = state.replica.replicas[r]!;
  if (rep.mode !== MODE.span) return;
  let n = decodeSpanStepsWithin(rep.span, T - rep.t0);
  if (n > rep.spanSteps - 1) n = rep.spanSteps - 1;
  while (rep.spanDone < n) {
    endDecodeStep(state, rep);
    rep.spanDone++;
    const startMs = rep.t0 + decodeSpanDurationMs(rep.span, rep.spanDone);
    startSpanStep(state, rep, r, Math.min(T, startMs));
  }
}

/**
 * Ends a span early: the step in flight at nowMs finishes (a new arrival waits for it), and the
 * scheduler replans at its end. Clamps the new end to nowMs against float error.
 */
export function truncateSpan(state: DayState, ctx: Ctx, r: number, kind: number): void {
  const rep = state.replica.replicas[r]!;
  if (rep.mode !== MODE.span) return;
  syncSpan(state, r, ctx.nowMs);
  const k = rep.spanDone + 1;
  if (k >= rep.spanSteps) return;
  rep.spanSteps = k;
  rep.t1 = rep.t0 + decodeSpanDurationMs(rep.span, k);
  rep.ev = ctx.reschedule(rep.ev, Math.max(ctx.nowMs, rep.t1), kind, r);
}

/**
 * How many steps a decode-only batch can run from the step with clock rep.clock (whose blocks are
 * already allocated) before a block allocation would fail. Allocations only take blocks, one per
 * block crossing; each run of blockSize steps crosses once per request.
 */
export function stepsUntilKvShort(rep: ReplicaEngine): number {
  const b = rep.desc.decodeSeqs;
  if (b === 0) return Infinity;
  const bs = rep.pool.blockSize;
  const avail = availableBlocks(rep.pool);
  const cycles = Math.floor(avail / b);
  let rem = avail - cycles * b;
  let j = cycles * bs;
  for (;;) {
    j++;
    const need = rep.groups[(rep.clock + j) % bs]!.length;
    if (need > rem) return j;
    rem -= need;
  }
}

// ----- Meters: pro-rata accrual of the step or span in flight -----

interface Work {
  busy: number;
  flops: number;
  decode: number;
  prefill: number;
  recomputed: number;
}

const work: Work = { busy: 0, flops: 0, decode: 0, prefill: 0, recomputed: 0 };

/** Work of the step or span in flight done by time T (all of it at or after its end). */
function workAt(rep: ReplicaEngine, T: number, out: Work): Work {
  const e = T - rep.t0;
  if (rep.mode === MODE.step) {
    const f = T >= rep.t1 || e >= rep.stepMs ? 1 : e <= 0 ? 0 : e / rep.stepMs;
    out.busy = f * rep.stepMs;
    out.flops = f * rep.stepFlops;
    out.decode = f * rep.stepDecode;
    out.prefill = f * rep.stepPrefill;
    out.recomputed = f * rep.stepRecomputed;
    return out;
  }
  const span = rep.span;
  const k = rep.spanSteps;
  const n = T >= rep.t1 ? k : Math.min(k, decodeSpanStepsWithin(span, e));
  let partial = 0;
  if (n < k) {
    const into = e - decodeSpanDurationMs(span, n);
    const len = decodeSpanStepMs(span, n);
    partial = into <= 0 ? 0 : into >= len ? 1 : into / len;
  }
  const done = decodeSpanDurationMs(span, n);
  out.busy = n < k ? Math.max(0, Math.min(e, decodeSpanDurationMs(span, k))) : done;
  out.flops =
    decodeSpanFlops(span, n) + (n < k ? partial * (span.flops0 + span.flopsSlope * n) : 0);
  out.decode = span.batch * (n + partial);
  out.prefill = 0;
  out.recomputed = 0;
  return out;
}

/** Adds the step or span in flight's work up to time T to the replica's meters. */
export function accrue(state: DayState, r: number, T: number): void {
  const rep = state.replica.replicas[r]!;
  if (rep.mode !== MODE.step && rep.mode !== MODE.span) return;
  const w = workAt(rep, T, work);
  const m = state.shared.meters.replica;
  m.busyMs[r] = m.busyMs[r]! + (w.busy - rep.acctBusy);
  m.flops[r] = m.flops[r]! + (w.flops - rep.acctFlops);
  m.decodeTokens[r] = m.decodeTokens[r]! + (w.decode - rep.acctDecode);
  m.prefillTokens[r] = m.prefillTokens[r]! + (w.prefill - rep.acctPrefill);
  m.recomputedPrefillTokens[r] =
    m.recomputedPrefillTokens[r]! + (w.recomputed - rep.acctRecomputed);
  rep.acctBusy = w.busy;
  rep.acctFlops = w.flops;
  rep.acctDecode = w.decode;
  rep.acctPrefill = w.prefill;
  rep.acctRecomputed = w.recomputed;
}

export function resetAccrual(rep: ReplicaEngine): void {
  rep.acctBusy = 0;
  rep.acctFlops = 0;
  rep.acctDecode = 0;
  rep.acctPrefill = 0;
  rep.acctRecomputed = 0;
}
