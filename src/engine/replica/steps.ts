// One engine step (02 §7, vLLM V1): compose it at its start, apply it at its end. index.ts states
// the rules; this file is their implementation. Composition extends a decode-only step into a span
// when event-jumping is on (span.ts).

import type { Ctx, DayState } from '../core/index.ts';
import { NO_EVENT, TOPIC, setLevel } from '../core/index.ts';
import {
  addPrefillChunk,
  decodeSpan,
  decodeSpanDurationMs,
  emptyStepCost,
  stepTime,
} from '../cost/index.ts';
import {
  acquireBlocks,
  allocateBlocks,
  blocksForTokens,
  canAcquire,
  kvUsedFrac,
  longestCachedPrefix,
  registerFullBlocks,
} from '../kv/index.ts';
import { OUTCOME, REQUEST_STATE } from '../results.ts';
import { pushNotice } from './notices.ts';
import {
  compactWaiting,
  detachRequest,
  endRequest,
  enterDecode,
  generatedTokens,
  preemptRequest,
} from './requests.ts';
import { endDecodeStep, resetAccrual, stepsUntilKvShort } from './span.ts';
import { EV_STEP_END, MODE, PHASE, waitingCount, type ReplicaEngine } from './state.ts';

/** What a composed step looks like; passed to SchedulerOptions.onStep (tests, E10 traces). */
export interface StepInfo {
  replica: number;
  atMs: number;
  /** Clock of the (first) step: steps the replica completed before it. */
  clock: number;
  decodeSeqs: number;
  decodeContextTokens: number;
  /** Prefill chunks in scheduling order: [slot, prior tokens, new tokens] triples, flattened. */
  chunks: number[];
  /** 1 for a single step; k for a decode-only span. */
  steps: number;
  durationMs: number;
  /** A preemption happened while composing this step. */
  preempted: boolean;
}

export interface SchedulerOptions {
  /** Event-jumping over decode-only spans (02 §5). Off: one event per step, for cross-checks. */
  readonly jumping: boolean;
  readonly onStep?: (info: StepInfo) => void;
}

// Scratch, never state: copies of lists that preemption may edit while we walk them.
const scratch: number[] = [];
const cost = emptyStepCost();

function copyOf(list: readonly number[], from = 0): number[] {
  scratch.length = 0;
  for (let i = from; i < list.length; i++) scratch.push(list[i]!);
  return scratch;
}

export function syncLevels(state: DayState, r: number, atMs: number): void {
  const rep = state.replica.replicas[r]!;
  const m = state.shared.meters.replica;
  setLevel(m.running[r]!, atMs, rep.running.length);
  setLevel(m.waiting[r]!, atMs, waitingCount(rep));
  setLevel(m.kvUsed[r]!, atMs, kvUsedFrac(rep.pool));
}

function pushChunk(state: DayState, rep: ReplicaEngine, s: number, prior: number, n: number) {
  rep.chunkSlot.push(s);
  rep.chunkPrior.push(prior);
  rep.chunkTokens.push(n);
  // Prefill below the high-water mark recomputes KV a preemption threw away.
  const hw = state.replica.req.highWater[s]!;
  return hw > prior ? Math.min(prior + n, hw) - prior : 0;
}

/** Preempts the most recently admitted running request (02 §7 rule 4). */
function preemptTail(state: DayState, rep: ReplicaEngine, r: number): number {
  const victim = rep.running[rep.running.length - 1]!;
  preemptRequest(state, rep, r, victim);
  return victim;
}

/** Rule 2, part 1: every decode-phase request computes one token; rule 3: blocks at boundaries. */
function scheduleDecodes(state: DayState, rep: ReplicaEngine, r: number): boolean {
  const q = state.replica.req;
  const group = rep.groups[rep.clock % rep.pool.blockSize]!;
  if (group.length === 0) return false;
  let preempted = false;
  let evicted = 0;
  for (const s of copyOf(group)) {
    if (q.phase[s] !== PHASE.decode) continue; // preempted earlier in this pass
    let ok = true;
    while (!allocateBlocks(rep.pool, 1, q.blocks[s]!, q.held[s]!)) {
      preempted = true;
      if (preemptTail(state, rep, r) === s) {
        ok = false;
        break;
      }
    }
    if (ok) {
      q.held[s] = q.held[s]! + 1;
      evicted += rep.pool.evictedCount;
    }
  }
  addEvictions(state, r, evicted);
  return preempted;
}

function addEvictions(state: DayState, r: number, evicted: number): void {
  if (evicted === 0) return;
  const m = state.shared.meters.replica;
  m.evictedBlocks[r] = m.evictedBlocks[r]! + evicted;
}

interface Budget {
  used: number;
  recomputed: number;
  preempted: boolean;
}

const budget: Budget = { used: 0, recomputed: 0, preempted: false };

/** Rule 2, part 2: running requests still in prefill get chunks, in admission order. */
function scheduleRunningPrefills(state: DayState, rep: ReplicaEngine, r: number, b: Budget) {
  if (rep.prefillCount === 0) return;
  const q = state.replica.req;
  const cap = state.replica.limits.maxNumBatchedTokens;
  let evicted = 0;
  for (const s of copyOf(rep.running)) {
    if (q.phase[s] !== PHASE.prefill) continue;
    if (b.used >= cap) break;
    const prior = q.computed[s]!;
    const n = Math.min(q.target[s]! - prior, cap - b.used);
    const need = blocksForTokens(rep.pool, prior + n) - q.held[s]!;
    let ok = true;
    if (need > 0) {
      while (!allocateBlocks(rep.pool, need, q.blocks[s]!, q.held[s]!)) {
        b.preempted = true;
        const tail = rep.running[rep.running.length - 1]!;
        if (tail !== s && rep.chunkSlot.includes(tail)) {
          throw new Error(`replica ${r}: would preempt a prefill already scheduled this step`);
        }
        if (q.phase[tail] === PHASE.decode) b.used -= 1;
        preemptTail(state, rep, r);
        if (tail === s) {
          ok = false;
          break;
        }
      }
      if (ok) {
        q.held[s] = q.held[s]! + need;
        evicted += rep.pool.evictedCount;
      }
    }
    if (!ok) break; // vLLM stops scheduling running requests once one preempts itself
    b.recomputed += pushChunk(state, rep, s, prior, n);
    b.used += n;
  }
  addEvictions(state, r, evicted);
}

/**
 * Rule 1: admit from the head of the waiting queue while the whole uncached prompt fits
 * (canAcquire, vLLM can_fit_full_sequence), allocating only the first chunk. FIFO with
 * head-of-line blocking, as in vLLM: the first request that doesn't fit stops admission.
 */
function admitWaiting(state: DayState, rep: ReplicaEngine, r: number, b: Budget): void {
  const sl = state.replica;
  const q = sl.req;
  const t = state.shared.requests;
  const lim = sl.limits;
  const pool = rep.pool;
  const m = state.shared.meters.replica;
  let evicted = 0;
  while (
    rep.waitHead < rep.waiting.length &&
    b.used < lim.maxNumBatchedTokens &&
    rep.running.length < lim.maxNumSeqs
  ) {
    const s = rep.waiting[rep.waitHead]!;
    const tokens = q.target[s]!;
    const blocks = q.blocks[s]!;
    // E4 recipe: lookup and acquire with nothing allocated or released in between.
    const hits = longestCachedPrefix(pool, t.session[s]!, t.systemPromptTokens[s]!, tokens, blocks);
    if (!canAcquire(pool, blocks, 0, hits, blocksForTokens(pool, tokens) - hits)) {
      blocks.length = 0;
      break;
    }
    const cached = hits * pool.blockSize;
    const n = Math.min(tokens - cached, lim.maxNumBatchedTokens - b.used);
    const fresh = blocksForTokens(pool, cached + n) - hits;
    if (!acquireBlocks(pool, blocks, 0, hits, fresh)) {
      throw new Error(`replica ${r}: admission passed canAcquire but acquireBlocks failed`);
    }
    evicted += pool.evictedCount;
    rep.waitHead++;
    q.held[s] = hits + fresh;
    q.registered[s] = hits;
    q.computed[s] = cached;
    q.hitTokens[s] = cached;
    q.phase[s] = PHASE.prefill;
    q.admitSeq[s] = sl.nextAdmitSeq++;
    rep.running.push(s);
    rep.prefillCount++;
    m.prefixQueryTokens[r] = m.prefixQueryTokens[r]! + tokens;
    m.prefixHitTokens[r] = m.prefixHitTokens[r]! + cached;
    if (t.turn[s]! >= 2) {
      m.returningQueryTokens[r] = m.returningQueryTokens[r]! + tokens;
      m.returningHitTokens[r] = m.returningHitTokens[r]! + cached;
    }
    b.recomputed += pushChunk(state, rep, s, cached, n);
    b.used += n;
    t.state[s] = REQUEST_STATE.prefill;
    pushNotice(TOPIC.requestState, s, REQUEST_STATE.prefill);
  }
  compactWaiting(rep);
  addEvictions(state, r, evicted);
}

/** Steps until the first decode-phase request finishes, counting the step being composed. */
function stepsUntilFinish(state: DayState, rep: ReplicaEngine): number {
  const q = state.replica.req;
  let k = Infinity;
  for (const s of rep.running) {
    if (q.phase[s] !== PHASE.decode) continue;
    const steps = q.finishClock[s]! - rep.clock + 1;
    if (steps < k) k = steps;
  }
  return k;
}

/**
 * Admission can't open up inside a span: blocks only get scarcer and the head's prefix hits only
 * shrink. The one exception is a running request of the head's own session registering blocks the
 * head would hit; sessions run one turn at a time (02 §8), but check rather than assume.
 */
function headSessionClear(state: DayState, rep: ReplicaEngine): boolean {
  if (rep.waitHead >= rep.waiting.length) return true;
  const session = state.shared.requests.session;
  const hs = session[rep.waiting[rep.waitHead]!]!;
  for (const s of rep.running) if (session[s] === hs) return false;
  return true;
}

/**
 * Composes the step starting now (rules 1-4) and schedules its end, or goes idle. With jumping
 * on, a decode-only step with no preemption extends into a span that runs to the earlier of the
 * next finish and the step whose block allocation would fail.
 */
export function compose(state: DayState, ctx: Ctx, r: number, opts: SchedulerOptions): void {
  const rep = state.replica.replicas[r]!;
  const now = ctx.nowMs;
  const desc = rep.desc;
  rep.chunkSlot.length = 0;
  rep.chunkPrior.length = 0;
  rep.chunkTokens.length = 0;
  rep.mode = MODE.idle;
  rep.ev = NO_EVENT;
  resetAccrual(rep);
  desc.prefillTokens = 0;
  desc.prefillPriorTokens = 0;
  desc.prefillAttentionPairs = 0;
  if (rep.running.length > 0 || waitingCount(rep) > 0) {
    budget.preempted = scheduleDecodes(state, rep, r);
    budget.used = desc.decodeSeqs;
    budget.recomputed = 0;
    scheduleRunningPrefills(state, rep, r, budget);
    // vLLM admits nothing in a step that preempted.
    if (!budget.preempted) admitWaiting(state, rep, r, budget);
  }
  if (desc.decodeSeqs === 0 && rep.chunkSlot.length === 0) {
    if (rep.running.length > 0 || waitingCount(rep) > 0) {
      throw new Error(`replica ${r}: composed an empty step with work queued`);
    }
    syncLevels(state, r, now);
    return;
  }
  for (let i = 0; i < rep.chunkSlot.length; i++) {
    addPrefillChunk(desc, rep.chunkPrior[i]!, rep.chunkTokens[i]!);
  }
  const cal = ctx.input.calibration;
  let k = 1;
  if (opts.jumping && rep.chunkSlot.length === 0 && !budget.preempted) {
    if (headSessionClear(state, rep)) {
      k = Math.min(stepsUntilFinish(state, rep), stepsUntilKvShort(rep));
    }
  }
  rep.t0 = now;
  if (k >= 2) {
    rep.mode = MODE.span;
    decodeSpan(desc.decodeSeqs, desc.decodeContextTokens, cal, rep.span);
    rep.spanSteps = k;
    rep.spanDone = 0;
    rep.t1 = now + decodeSpanDurationMs(rep.span, k);
  } else {
    stepTime(desc, cal, cost);
    rep.mode = MODE.step;
    rep.stepMs = cost.stepMs;
    rep.stepFlops = cost.flops;
    rep.stepDecode = desc.decodeSeqs;
    rep.stepPrefill = desc.prefillTokens;
    rep.stepRecomputed = budget.recomputed;
    rep.t1 = now + cost.stepMs;
  }
  rep.ev = ctx.schedule(Math.max(now, rep.t1), EV_STEP_END, r);
  syncLevels(state, r, now);
  if (opts.onStep) {
    const chunks: number[] = [];
    for (let i = 0; i < rep.chunkSlot.length; i++) {
      chunks.push(rep.chunkSlot[i]!, rep.chunkPrior[i]!, rep.chunkTokens[i]!);
    }
    opts.onStep({
      replica: r,
      atMs: now,
      clock: rep.clock,
      decodeSeqs: desc.decodeSeqs,
      decodeContextTokens: desc.decodeContextTokens,
      chunks,
      steps: k >= 2 ? k : 1,
      durationMs: rep.t1 - now,
      preempted: budget.preempted,
    });
  }
}

/**
 * Applies the step in flight at its end: blocks filled by decodes are registered, finished
 * decodes release their blocks, and each chunk's KV is registered. A chunk that completes its
 * prefill samples a token: the first token (TTFT) unless the request is resuming after a
 * preemption; the request then finishes or starts decoding. Order: decode registrations, decode
 * finishes (admission order), then chunks (scheduling order).
 */
export function finishStep(state: DayState, ctx: Ctx, r: number): void {
  const rep = state.replica.replicas[r]!;
  const q = state.replica.req;
  const t = state.shared.requests;
  const now = ctx.nowMs;
  const decoding = rep.desc.decodeSeqs > 0;
  endDecodeStep(state, rep);
  const c = rep.clock - 1;
  if (decoding && rep.running.some((s) => q.finishClock[s] === c && q.phase[s] === PHASE.decode)) {
    for (const s of copyOf(rep.running)) {
      if (q.phase[s] !== PHASE.decode || q.finishClock[s] !== c) continue;
      const g = generatedTokens(state, s);
      detachRequest(state, rep, s);
      endRequest(state, s, OUTCOME.finished, now, g);
    }
  }
  for (let i = 0; i < rep.chunkSlot.length; i++) {
    const s = rep.chunkSlot[i]!;
    if (s < 0) continue; // cancelled while its chunk ran
    const computed = rep.chunkPrior[i]! + rep.chunkTokens[i]!;
    q.computed[s] = computed;
    q.registered[s] = registerFullBlocks(
      rep.pool,
      t.session[s]!,
      t.systemPromptTokens[s]!,
      q.blocks[s]!,
      0,
      q.registered[s]!,
      computed,
    );
    if (computed < q.target[s]!) continue;
    const g = q.generated[s]! + 1;
    q.generated[s] = g;
    if (Number.isNaN(t.firstTokenMs[s]!)) {
      t.firstTokenMs[s] = now;
      t.cachedTokens[s] = q.hitTokens[s]!;
      pushNotice(TOPIC.firstToken, s, r);
    }
    if (g >= Math.max(1, t.outputTarget[s]!)) {
      detachRequest(state, rep, s);
      endRequest(state, s, OUTCOME.finished, now, g);
    } else {
      enterDecode(state, rep, r, s);
    }
  }
  rep.chunkSlot.length = 0;
  rep.chunkPrior.length = 0;
  rep.chunkTokens.length = 0;
}
