// Per-request moves inside one replica: enter decode, preempt, release, and end. Each changes the
// replica's queues, the KV pool (following E4's recipe in kv/index.ts), the E3 decode aggregates,
// and the shared request table's E5-owned fields, then queues the notices (notices.ts).

import type { DayState } from '../core/index.ts';
import { TOPIC } from '../core/index.ts';
import { registerFullBlocks, releaseBlocks } from '../kv/index.ts';
import { REQUEST_STATE } from '../results.ts';
import type { RequestSlot } from '../shared/index.ts';
import { pushNotice } from './notices.ts';
import { PHASE, groupKey, type ReplicaEngine } from './state.ts';

/** Tokens whose KV exists for a request in prefill or decode phase. */
export function computedTokens(state: DayState, s: RequestSlot): number {
  const q = state.replica.req;
  if (q.phase[s] === PHASE.decode) {
    return q.decodeBase[s]! + state.replica.replicas[q.replica[s]!]!.clock;
  }
  return q.phase[s] === PHASE.prefill ? q.computed[s]! : 0;
}

/** Output tokens generated so far (as of the replica's materialized clock). */
export function generatedTokens(state: DayState, s: RequestSlot): number {
  const q = state.replica.req;
  if (q.phase[s] === PHASE.decode) {
    return computedTokens(state, s) - state.shared.requests.promptTokens[s]! + 1;
  }
  return q.generated[s]!;
}

/** Inserts s into a list sorted by admitSeq (usually at the end). */
function insertByAdmission(list: number[], s: RequestSlot, admitSeq: Float64Array): void {
  const seq = admitSeq[s]!;
  let i = list.length;
  while (i > 0 && admitSeq[list[i - 1]!]! > seq) i--;
  list.splice(i, 0, s);
}

function removeFrom(list: number[], s: RequestSlot): void {
  const i = list.lastIndexOf(s);
  if (i < 0) throw new Error(`replica: request slot ${s} is missing from a list`);
  list.splice(i, 1);
}

/** A request whose prefill just completed and that has output left to generate starts decoding. */
export function enterDecode(state: DayState, rep: ReplicaEngine, r: number, s: RequestSlot): void {
  const q = state.replica.req;
  const t = state.shared.requests;
  const g = q.generated[s]!;
  const computed = q.computed[s]!;
  q.phase[s] = PHASE.decode;
  rep.prefillCount--;
  q.decodeBase[s] = computed - rep.clock;
  // After the step with clock c the request has g + (c - clock) + 1 tokens.
  q.finishClock[s] = rep.clock + Math.max(1, t.outputTarget[s]!) - g - 1;
  insertByAdmission(rep.groups[groupKey(q.decodeBase[s]!, rep.pool.blockSize)]!, s, q.admitSeq);
  rep.desc.decodeSeqs += 1;
  rep.desc.decodeContextTokens += computed + 1;
  t.state[s] = REQUEST_STATE.decode;
  pushNotice(TOPIC.requestState, s, REQUEST_STATE.decode);
}

/**
 * Takes a running request out of the running list, its group, and the aggregates. Returns the
 * tokens whose KV exists. Leaves its blocks held.
 */
function leaveRunning(state: DayState, rep: ReplicaEngine, s: RequestSlot): number {
  const q = state.replica.req;
  const computed = computedTokens(state, s);
  if (q.phase[s] === PHASE.decode) {
    removeFrom(rep.groups[groupKey(q.decodeBase[s]!, rep.pool.blockSize)]!, s);
    rep.desc.decodeSeqs -= 1;
    rep.desc.decodeContextTokens -= computed + 1;
    q.generated[s] = computed - state.shared.requests.promptTokens[s]! + 1;
  } else {
    rep.prefillCount--;
    // A chunk scheduled in the step in flight no longer applies.
    const i = rep.chunkSlot.indexOf(s);
    if (i >= 0) rep.chunkSlot[i] = -1;
  }
  if (rep.running[rep.running.length - 1] === s) rep.running.pop();
  else removeFrom(rep.running, s);
  return computed;
}

/** Register the full blocks (so they stay cached), then release them all (E4 recipe). */
function registerAndRelease(
  state: DayState,
  rep: ReplicaEngine,
  s: RequestSlot,
  computed: number,
): void {
  const q = state.replica.req;
  const t = state.shared.requests;
  const blocks = q.blocks[s]!;
  if (q.held[s]! > 0) {
    registerFullBlocks(
      rep.pool,
      t.session[s]!,
      t.systemPromptTokens[s]!,
      blocks,
      0,
      q.registered[s]!,
      computed,
    );
    releaseBlocks(rep.pool, blocks, 0, q.held[s]!);
  }
  q.held[s] = 0;
  q.registered[s] = 0;
  blocks.length = 0;
}

function removeWaiting(rep: ReplicaEngine, s: RequestSlot): boolean {
  const i = rep.waiting.indexOf(s, rep.waitHead);
  if (i < 0) throw new Error(`replica: request slot ${s} is not waiting`);
  const wasHead = i === rep.waitHead;
  if (wasHead) rep.waitHead++;
  else rep.waiting.splice(i, 1);
  compactWaiting(rep);
  return wasHead;
}

export function compactWaiting(rep: ReplicaEngine): void {
  if (rep.waitHead === rep.waiting.length) {
    rep.waiting.length = 0;
    rep.waitHead = 0;
  } else if (rep.waitHead > 256 && rep.waitHead * 2 > rep.waiting.length) {
    rep.waiting.splice(0, rep.waitHead);
    rep.waitHead = 0;
  }
}

/**
 * Takes a request out of this replica wherever it is, registering then releasing its blocks.
 * Returns whether it was the waiting head (so the scheduler knows admission may have changed).
 */
export function detachRequest(state: DayState, rep: ReplicaEngine, s: RequestSlot): boolean {
  const q = state.replica.req;
  if (q.phase[s] === PHASE.waiting) return removeWaiting(rep, s);
  const computed = leaveRunning(state, rep, s);
  registerAndRelease(state, rep, s, computed);
  return false;
}

/**
 * Ends a request this replica held: fills the E5 fields and queues requestState and requestEnded.
 * `outcome` is an OUTCOME code. The request must already be detached.
 */
export function endRequest(
  state: DayState,
  s: RequestSlot,
  outcome: number,
  nowMs: number,
  outputDone: number,
): void {
  const t = state.shared.requests;
  const q = state.replica.req;
  q.phase[s] = PHASE.none;
  q.replica[s] = -1;
  t.outputDone[s] = outputDone;
  t.endMs[s] = nowMs;
  t.outcome[s] = outcome;
  t.state[s] = outcome;
  pushNotice(TOPIC.requestState, s, outcome);
  pushNotice(TOPIC.requestEnded, s, outcome);
}

/**
 * Preemption (02 §7 rule 4, recompute mode): register and free the request's blocks and put it at
 * the front of the waiting queue. It resumes by prefilling its prompt plus the output so far,
 * which may partly hit the prefix cache.
 */
export function preemptRequest(
  state: DayState,
  rep: ReplicaEngine,
  r: number,
  s: RequestSlot,
): void {
  const q = state.replica.req;
  const t = state.shared.requests;
  const computed = leaveRunning(state, rep, s);
  registerAndRelease(state, rep, s, computed);
  if (computed > q.highWater[s]!) q.highWater[s] = computed;
  q.target[s] = t.promptTokens[s]! + q.generated[s]!;
  q.computed[s] = 0;
  q.phase[s] = PHASE.waiting;
  if (rep.waitHead > 0) rep.waiting[--rep.waitHead] = s;
  else rep.waiting.unshift(s);
  t.preemptions[s] = t.preemptions[s]! + 1;
  state.shared.meters.replica.preemptions[r]! += 1;
  t.state[s] = REQUEST_STATE.preempted;
  pushNotice(TOPIC.requestState, s, REQUEST_STATE.preempted);
}
