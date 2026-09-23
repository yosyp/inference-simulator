// The oracle's replica: one vLLM V1-style scheduler, written to be read, not to be fast. Every
// engine step is composed and applied on its own; there is no event-jumping, no lazy state, no
// running aggregate, and no per-residue grouping. Each request carries its own token counts
// (computed, generated), and each step's cost is rebuilt from scratch with E3's stepTime. It
// shares only E3 (cost) and E4 (KV pool) with the engine; it does not import src/engine/replica.
//
// The rules (02 §7 and K32), one step at a time:
//   Compose, at the start of a step:
//   A. Every decode-phase request decodes one token. In admission order, one whose next token
//      starts a new block (blocksForTokens(computed + 1) > blocks held) allocates it; if the pool
//      is short, the most recently admitted running request is preempted, again and again, until
//      the allocation succeeds or the request has preempted itself.
//   B. Running requests still in prefill, in admission order, take a chunk of
//      min(remaining, budget left) from max_num_batched_tokens (decodes use one token each),
//      allocating its blocks; a short pool preempts as in A (a preempted decode gives its token
//      back). Once a request preempts itself, B stops (it was the tail, so nothing follows).
//   C. Only if nothing was preempted: admit from the head of the waiting queue while fewer than
//      max_num_seqs run and budget is left. The head goes in when blocks for its whole uncached
//      prompt fit (E4 canAcquire over its longest cached prefix); only its first chunk is
//      allocated. The first head that doesn't fit stops admission (FIFO, head-of-line).
//   Apply, at the end of the step, in this order (LRU contents depend on it):
//   1. every decode-phase request has one more token; full blocks register, in admission order;
//   2. decode requests that reached their output target finish, in admission order;
//   3. chunks in scheduling order: register full blocks; a chunk that completes the prefill
//      samples a token (the first token unless it was sampled before a preemption), then the
//      request finishes or starts decoding.
//   A request that leaves (finish, cancel, preemption) registers its full blocks, then releases.
//   A preempted request goes to the front of the waiting queue and later prefills its prompt
//   plus the output so far.

import type { Calibration } from '../calibration.ts';
import { addDecodeSequence, addPrefillChunk, emptyStepDesc, stepTime } from '../cost/index.ts';
import {
  acquireBlocks,
  allocateBlocks,
  blocksForTokens,
  canAcquire,
  createKvPool,
  longestCachedPrefix,
  registerFullBlocks,
  releaseBlocks,
  resetKvPool,
  type KvPool,
} from '../kv/index.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import type { CounterTotals, StepRecord } from './types.ts';

export const PHASE = { none: 0, waiting: 1, prefill: 2, decode: 3 } as const;

export interface EngineLimits {
  kvPoolTokens: number;
  blockSize: number;
  maxNumSeqs: number;
  maxNumBatchedTokens: number;
  maxModelLen: number;
}

/** A request as the oracle tracks it. `i` is its index in the input. */
export interface OReq {
  i: number;
  session: number;
  turn: number;
  promptTokens: number;
  outputTarget: number;
  systemPromptTokens: number;
  phase: number;
  /** Block table: blocks[k] holds sequence block k. Its length is the blocks held. */
  blocks: number[];
  /** Leading blocks that went through registration. */
  registered: number;
  /** Tokens whose KV exists. */
  computed: number;
  /** Tokens this admission must prefill: the prompt, plus the output so far after a preemption. */
  target: number;
  /** Output tokens sampled so far. */
  generated: number;
  /** Prefix-cache hit tokens at the latest admission. */
  hitTokens: number;
  /** Most tokens whose KV existed before a preemption; prefill below it is recompute. */
  highWater: number;
  firstTokenMs: number;
  cachedTokens: number;
  preemptions: number;
}

interface Chunk {
  req: OReq;
  prior: number;
  n: number;
  /** The request left while the chunk was in flight. */
  dead: boolean;
}

/** What the scheduler needs from the loop around it (sim.ts). */
export interface Host {
  readonly cal: Calibration;
  readonly limits: EngineLimits;
  readonly counters: CounterTotals;
  /** Set to collect a StepRecord per composed step. */
  readonly trace: StepRecord[] | null;
  /** Queue this replica's step end or kick; returns a handle for cancelStep. */
  scheduleStep(r: number, atMs: number, kick: boolean): number;
  cancelStep(handle: number): void;
  transition(req: OReq, state: number, atMs: number): void;
  firstToken(req: OReq, atMs: number): void;
  /** The request ended here with an OUTCOME code; it was already taken out of the replica. */
  ended(req: OReq, outcome: number, atMs: number, outputDone: number): void;
}

export interface OReplica {
  r: number;
  state: number;
  pool: KvPool;
  /** waiting[0] is the head. */
  waiting: OReq[];
  /** Admission order: the last entry is the most recently admitted. */
  running: OReq[];
  mode: 'idle' | 'kick' | 'step';
  /** Handle of the pending kick or step end; -1 if none. */
  handle: number;
  /** Steps completed. */
  clock: number;
  /** The step in flight. */
  t0: number;
  stepMs: number;
  flops: number;
  decodes: number;
  prefill: number;
  recomputed: number;
  chunks: Chunk[];
}

export function createReplica(r: number, pool: KvPool): OReplica {
  return {
    ...{ r, state: REPLICA_STATE.ready, pool, waiting: [], running: [], mode: 'idle' },
    ...{ handle: -1, clock: 0, t0: 0, stepMs: 0, flops: 0, decodes: 0, prefill: 0 },
    ...{ recomputed: 0, chunks: [] },
  };
}

function hasWork(rep: OReplica): boolean {
  return rep.running.length > 0 || rep.waiting.length > 0;
}

function count(host: Host, rep: OReplica, counter: keyof CounterTotals, by: number): void {
  host.counters[counter][rep.r]! += by;
}

// ----- Leaving the replica -----

/** Registers the request's full blocks, then releases them all (E4 recipe). */
function registerAndRelease(rep: OReplica, req: OReq): void {
  if (req.blocks.length > 0) {
    registerFullBlocks(
      rep.pool,
      req.session,
      req.systemPromptTokens,
      req.blocks,
      0,
      req.registered,
      req.computed,
    );
    releaseBlocks(rep.pool, req.blocks, 0, req.blocks.length);
  }
  req.blocks.length = 0;
  req.registered = 0;
}

function leaveRunning(rep: OReplica, req: OReq): void {
  const k = rep.running.indexOf(req);
  if (k < 0) throw new Error(`oracle: request ${req.i} is not running on replica ${rep.r}`);
  rep.running.splice(k, 1);
  for (const c of rep.chunks) if (c.req === req) c.dead = true;
  registerAndRelease(rep, req);
}

/** Rule 4: the most recently admitted running request is preempted (recompute). */
function preemptTail(host: Host, rep: OReplica, now: number): OReq {
  const victim = rep.running[rep.running.length - 1]!;
  if (rep.chunks.some((c) => c.req === victim)) {
    throw new Error(`oracle: would preempt request ${victim.i}, already given a chunk this step`);
  }
  leaveRunning(rep, victim);
  victim.highWater = Math.max(victim.highWater, victim.computed);
  victim.target = victim.promptTokens + victim.generated;
  victim.computed = 0;
  victim.phase = PHASE.waiting;
  rep.waiting.unshift(victim);
  victim.preemptions++;
  count(host, rep, 'preemptions', 1);
  host.transition(victim, REQUEST_STATE.preempted, now);
  return victim;
}

function finish(host: Host, rep: OReplica, req: OReq, now: number): void {
  leaveRunning(rep, req);
  req.phase = PHASE.none;
  host.ended(req, OUTCOME.finished, now, req.generated);
}

// ----- Composing a step -----

function addChunk(rep: OReplica, req: OReq, prior: number, n: number): void {
  rep.chunks.push({ req, prior, n, dead: false });
  if (req.highWater > prior) rep.recomputed += Math.min(prior + n, req.highWater) - prior;
}

/** Token budget the step uses so far: one per decode-phase request plus every chunk's tokens. */
function budgetUsed(rep: OReplica): number {
  let used = 0;
  for (const req of rep.running) if (req.phase === PHASE.decode) used++;
  for (const c of rep.chunks) used += c.n;
  return used;
}

/**
 * Allocates n more blocks for req, preempting the most recently admitted running request until
 * they fit. Returns whether it preempted anything, and whether req still runs.
 */
function allocateOrPreempt(host: Host, rep: OReplica, req: OReq, n: number, now: number) {
  let preempted = false;
  while (!allocateBlocks(rep.pool, n, req.blocks, req.blocks.length)) {
    preempted = true;
    if (preemptTail(host, rep, now) === req) return { ok: false, preempted };
  }
  count(host, rep, 'evictedBlocks', rep.pool.evictedCount);
  return { ok: true, preempted };
}

/** Composes the step starting now and schedules its end, or goes idle. */
export function compose(host: Host, rep: OReplica, now: number): void {
  const lim = host.limits;
  const pool = rep.pool;
  rep.chunks = [];
  rep.recomputed = 0;
  let preempted = false;

  // A. Decodes: block growth at block boundaries, in admission order.
  for (const req of rep.running.slice()) {
    if (req.phase !== PHASE.decode) continue; // preempted earlier in this pass
    if (blocksForTokens(pool, req.computed + 1) <= req.blocks.length) continue;
    if (allocateOrPreempt(host, rep, req, 1, now).preempted) preempted = true;
  }

  // B. Running prefills get chunks, in admission order. A decode preempted here frees its token.
  for (const req of rep.running.slice()) {
    if (req.phase !== PHASE.prefill) continue;
    const used = budgetUsed(rep);
    if (used >= lim.maxNumBatchedTokens) break;
    const prior = req.computed;
    const n = Math.min(req.target - prior, lim.maxNumBatchedTokens - used);
    const need = blocksForTokens(pool, prior + n) - req.blocks.length;
    if (need > 0) {
      const res = allocateOrPreempt(host, rep, req, need, now);
      if (res.preempted) preempted = true;
      // It preempted itself, so it was the tail: nothing after it runs anyway.
      if (!res.ok) break;
    }
    addChunk(rep, req, prior, n);
  }

  // C. Admissions, FIFO with head-of-line blocking; none in a step that preempted.
  while (
    !preempted &&
    rep.waiting.length > 0 &&
    budgetUsed(rep) < lim.maxNumBatchedTokens &&
    rep.running.length < lim.maxNumSeqs
  ) {
    const req = rep.waiting[0]!;
    const tokens = req.target;
    const hits = longestCachedPrefix(pool, req.session, req.systemPromptTokens, tokens, req.blocks);
    if (!canAcquire(pool, req.blocks, 0, hits, blocksForTokens(pool, tokens) - hits)) {
      req.blocks.length = 0;
      break;
    }
    const cached = hits * pool.blockSize;
    const n = Math.min(tokens - cached, lim.maxNumBatchedTokens - budgetUsed(rep));
    const fresh = blocksForTokens(pool, cached + n) - hits;
    if (!acquireBlocks(pool, req.blocks, 0, hits, fresh)) {
      throw new Error(`oracle: request ${req.i} passed canAcquire but acquireBlocks failed`);
    }
    count(host, rep, 'evictedBlocks', pool.evictedCount);
    rep.waiting.shift();
    req.registered = hits;
    req.computed = cached;
    req.hitTokens = cached;
    req.phase = PHASE.prefill;
    rep.running.push(req);
    count(host, rep, 'prefixQueryTokens', tokens);
    count(host, rep, 'prefixHitTokens', cached);
    if (req.turn >= 2) {
      count(host, rep, 'returningQueryTokens', tokens);
      count(host, rep, 'returningHitTokens', cached);
    }
    addChunk(rep, req, cached, n);
    host.transition(req, REQUEST_STATE.prefill, now);
  }

  // The step's cost, from scratch.
  const desc = emptyStepDesc();
  for (const req of rep.running) {
    if (req.phase === PHASE.decode) addDecodeSequence(desc, req.computed + 1);
  }
  for (const c of rep.chunks) addPrefillChunk(desc, c.prior, c.n);
  if (desc.decodeSeqs === 0 && rep.chunks.length === 0) {
    if (hasWork(rep)) throw new Error(`oracle: replica ${rep.r} composed an empty step`);
    rep.mode = 'idle';
    rep.handle = -1;
    return;
  }
  const cost = stepTime(desc, host.cal);
  rep.t0 = now;
  rep.stepMs = cost.stepMs;
  rep.flops = cost.flops;
  rep.decodes = desc.decodeSeqs;
  rep.prefill = desc.prefillTokens;
  rep.mode = 'step';
  rep.handle = host.scheduleStep(rep.r, now + cost.stepMs, false);
  host.trace?.push({
    replica: rep.r,
    clock: rep.clock,
    atMs: now,
    durationMs: cost.stepMs,
    steps: 1,
    decodeSeqs: desc.decodeSeqs,
    decodeContextTokens: desc.decodeContextTokens,
    chunks: rep.chunks.flatMap((c) => [c.req.i, c.prior, c.n]),
    preempted,
  });
}

// ----- Applying a step -----

/** Adds fraction f of the step in flight to the meters. */
function accrue(host: Host, rep: OReplica, f: number): void {
  count(host, rep, 'busyMs', f * rep.stepMs);
  count(host, rep, 'flops', f * rep.flops);
  count(host, rep, 'decodeTokens', f * rep.decodes);
  count(host, rep, 'prefillTokens', f * rep.prefill);
  count(host, rep, 'recomputedPrefillTokens', f * rep.recomputed);
}

/** The step in flight ends now: apply it (steps 1-3 above), then compose the next. */
export function endStep(host: Host, rep: OReplica, now: number): void {
  accrue(host, rep, 1);
  rep.clock++;
  const pool = rep.pool;
  // 1. Decodes computed one more token each; register the blocks they filled.
  for (const req of rep.running) {
    if (req.phase !== PHASE.decode) continue;
    req.computed++;
    req.generated++;
    const { session, systemPromptTokens: sys, blocks, registered, computed } = req;
    req.registered = registerFullBlocks(pool, session, sys, blocks, 0, registered, computed);
  }
  // 2. Decodes that reached their target finish.
  for (const req of rep.running.slice()) {
    if (req.phase === PHASE.decode && req.generated >= Math.max(1, req.outputTarget)) {
      finish(host, rep, req, now);
    }
  }
  // 3. Chunks, in scheduling order.
  for (const c of rep.chunks) {
    if (c.dead) continue;
    const req = c.req;
    req.computed = c.prior + c.n;
    const { session, systemPromptTokens: sys, blocks, registered, computed } = req;
    req.registered = registerFullBlocks(pool, session, sys, blocks, 0, registered, computed);
    if (req.computed < req.target) continue;
    req.generated++;
    if (Number.isNaN(req.firstTokenMs)) {
      req.firstTokenMs = now;
      req.cachedTokens = req.hitTokens;
      host.firstToken(req, now);
    }
    if (req.generated >= Math.max(1, req.outputTarget)) {
      finish(host, rep, req, now);
    } else {
      req.phase = PHASE.decode;
      host.transition(req, REQUEST_STATE.decode, now);
    }
  }
  rep.chunks = [];
  compose(host, rep, now);
}

// ----- Requests arriving and leaving from outside -----

/** Whether the request could ever run here (else it would block the queue forever). */
function canEverRun(host: Host, rep: OReplica, req: OReq): boolean {
  const output = Math.max(1, req.outputTarget);
  if (req.promptTokens + output > host.limits.maxModelLen) return false;
  return blocksForTokens(rep.pool, req.promptTokens + output - 1) <= rep.pool.totalBlocks;
}

/** A request dispatched to this replica joins the waiting queue, or fails at once. */
export function enqueue(host: Host, rep: OReplica, req: OReq, now: number): void {
  if (rep.state !== REPLICA_STATE.ready || !canEverRun(host, rep, req)) {
    req.phase = PHASE.none;
    host.ended(req, OUTCOME.failed, now, 0);
    return;
  }
  req.phase = PHASE.waiting;
  req.blocks = [];
  req.registered = 0;
  req.computed = 0;
  req.target = req.promptTokens;
  req.generated = 0;
  req.hitTokens = 0;
  req.highWater = 0;
  rep.waiting.push(req);
  host.transition(req, REQUEST_STATE.waiting, now);
  if (rep.mode === 'idle') {
    // The first step is composed once the instant settles (priority late), so same-instant
    // dispatches share it.
    rep.mode = 'kick';
    rep.handle = host.scheduleStep(rep.r, now, true);
  }
}

/** The client gave up: the request leaves at once. A step in flight keeps its cost. */
export function cancel(host: Host, rep: OReplica, req: OReq, now: number): void {
  const output = req.generated;
  if (req.phase === PHASE.waiting) {
    rep.waiting.splice(rep.waiting.indexOf(req), 1);
  } else {
    leaveRunning(rep, req);
  }
  req.phase = PHASE.none;
  host.ended(req, OUTCOME.timedOut, now, output);
  if (rep.mode === 'kick' && !hasWork(rep)) {
    host.cancelStep(rep.handle);
    rep.handle = -1;
    rep.mode = 'idle';
  }
}

/** REPLICA_STATE change: leaving Ready fails everything and wipes KV; Ready rejoins cold. */
export function setState(host: Host, rep: OReplica, code: number, now: number): void {
  const was = rep.state;
  rep.state = code;
  if (code === REPLICA_STATE.ready) {
    if (was !== REPLICA_STATE.ready) rep.pool = createKvPool(host.limits);
    return;
  }
  if (!(was === REPLICA_STATE.ready || hasWork(rep) || rep.mode !== 'idle')) return;
  if (rep.mode === 'step') {
    // The part of the step in flight done by now counts; the rest never happens.
    const e = now - rep.t0;
    accrue(host, rep, e >= rep.stepMs ? 1 : e <= 0 ? 0 : e / rep.stepMs);
  }
  const doomed = [...rep.running, ...rep.waiting];
  rep.running = [];
  rep.waiting = [];
  rep.chunks = [];
  if (rep.handle >= 0) host.cancelStep(rep.handle);
  rep.handle = -1;
  rep.mode = 'idle';
  resetKvPool(rep.pool);
  for (const req of doomed) {
    req.blocks.length = 0;
    req.registered = 0;
    req.phase = PHASE.none;
    host.ended(req, OUTCOME.failed, now, req.generated);
  }
}
