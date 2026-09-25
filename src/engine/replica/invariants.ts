// assertInvariants for the replica module (00-build §7.1). O(requests + blocks) per replica; tests
// call it after every event.

import { NO_EVENT, type Ctx, type DayState } from '../core/index.ts';
import { assertInvariants as assertStepDesc } from '../cost/index.ts';
import { assertKvInvariants, blocksForTokens, kvUsedFrac } from '../kv/index.ts';
import { REPLICA_STATE, REQUEST_STATE } from '../results.ts';
import { isLive } from '../shared/index.ts';
import { MODE, PHASE, groupKey, waitingCount, type ReplicaEngine } from './state.ts';

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Replica invariant: ${message}`);
}

function assertRequests(
  state: DayState,
  ctx: Ctx,
  rep: ReplicaEngine,
  r: number,
  seen: Uint8Array,
): void {
  const q = state.replica.req;
  const t = state.shared.requests;
  const bs = rep.pool.blockSize;
  const heldCounts = new Int32Array(rep.pool.totalBlocks);
  const own = (s: number, what: string) => {
    check(s >= 0 && s < q.capacity, `${what} slot ${s} out of range`);
    check(seen[s] === 0, `slot ${s} is in two queues`);
    seen[s] = 1;
    check(isLive(t, s), `slot ${s} (${what}) is not live`);
    check(q.replica[s] === r, `slot ${s} is on replica ${q.replica[s]}, listed on ${r}`);
    for (let i = 0; i < q.held[s]!; i++) heldCounts[q.blocks[s]![i]!]!++;
  };
  for (let i = rep.waitHead; i < rep.waiting.length; i++) {
    const s = rep.waiting[i]!;
    own(s, 'waiting');
    check(q.phase[s] === PHASE.waiting, `waiting slot ${s} has phase ${q.phase[s]}`);
    const st = t.state[s];
    check(
      st === REQUEST_STATE.waiting || st === REQUEST_STATE.preempted,
      `waiting slot ${s} state ${st}`,
    );
    check(q.held[s] === 0, `waiting slot ${s} holds ${q.held[s]} blocks`);
  }
  // An eligibility past the day's end has no event; the day ends first.
  const lateOk = ctx.dayEndMs - ctx.nowMs <= ctx.input.calibration.costModel.requestOverheadMs;
  for (const s of rep.arriving) {
    own(s, 'arriving');
    check(q.phase[s] === PHASE.arriving, `arriving slot ${s} has phase ${q.phase[s]}`);
    check(t.state[s] === REQUEST_STATE.waiting, `arriving slot ${s} state ${t.state[s]}`);
    check(q.held[s] === 0, `arriving slot ${s} holds ${q.held[s]} blocks`);
    const h = q.eligibleEv[s]!;
    check(h === NO_EVENT ? lateOk : ctx.isPending(h), `arriving slot ${s} has no eligibility`);
  }
  let prefill = 0;
  let decode = 0;
  let context = 0;
  let lastSeq = -Infinity;
  for (const s of rep.running) {
    own(s, 'running');
    check(q.admitSeq[s]! > lastSeq, `running list out of admission order at slot ${s}`);
    lastSeq = q.admitSeq[s]!;
    const held = q.held[s]!;
    if (q.phase[s] === PHASE.prefill) {
      prefill++;
      check(t.state[s] === REQUEST_STATE.prefill, `prefill slot ${s} state ${t.state[s]}`);
      const computed = q.computed[s]!;
      const i = rep.chunkSlot.indexOf(s);
      const holds = computed + (i >= 0 ? rep.chunkTokens[i]! : 0);
      check(computed < q.target[s]!, `prefill slot ${s} already computed its target`);
      check(held === blocksForTokens(rep.pool, holds), `prefill slot ${s} holds ${held} blocks`);
      check(q.registered[s] === Math.floor(computed / bs), `prefill slot ${s} registration`);
    } else {
      check(q.phase[s] === PHASE.decode, `running slot ${s} has phase ${q.phase[s]}`);
      decode++;
      check(t.state[s] === REQUEST_STATE.decode, `decode slot ${s} state ${t.state[s]}`);
      const computed = q.decodeBase[s]! + rep.clock;
      context += computed + 1;
      check(held === blocksForTokens(rep.pool, computed + 1), `decode slot ${s} holds ${held}`);
      check(q.registered[s] === Math.floor(computed / bs), `decode slot ${s} registration`);
      const g = computed - t.promptTokens[s]! + 1;
      check(g >= 1 && g < Math.max(1, t.outputTarget[s]!), `decode slot ${s} has ${g} tokens`);
      check(q.finishClock[s]! >= rep.clock, `decode slot ${s} finish clock passed`);
      const group = rep.groups[groupKey(q.decodeBase[s]!, bs)]!;
      check(group.includes(s), `decode slot ${s} missing from its block group`);
    }
  }
  check(prefill === rep.prefillCount, `prefillCount ${rep.prefillCount}, found ${prefill}`);
  let grouped = 0;
  for (const g of rep.groups) {
    grouped += g.length;
    for (let i = 1; i < g.length; i++) {
      check(q.admitSeq[g[i - 1]!]! < q.admitSeq[g[i]!]!, 'block group out of admission order');
    }
  }
  check(grouped === decode, `${grouped} requests in block groups, ${decode} decoding`);
  const d = rep.desc;
  check(d.decodeSeqs === decode, `desc.decodeSeqs ${d.decodeSeqs}, ${decode} decoding`);
  check(
    d.decodeContextTokens === context,
    `desc.decodeContextTokens ${d.decodeContextTokens} ≠ ${context}`,
  );
  assertStepDesc(d);
  assertKvInvariants(rep.pool, heldCounts);
}

function assertSchedule(state: DayState, ctx: Ctx, rep: ReplicaEngine, r: number): void {
  const work = rep.running.length > 0 || waitingCount(rep) > 0;
  if (rep.state !== REPLICA_STATE.ready) {
    check(!work && rep.mode === MODE.idle, `replica ${r} is not Ready but holds work`);
    check(rep.arriving.length === 0, `replica ${r} is not Ready but has requests arriving`);
    check(rep.pool.referencedCount === 0, `replica ${r} is not Ready but holds blocks`);
  }
  if (rep.mode === MODE.idle) {
    check(!work, `replica ${r} is idle with work queued`);
    check(!ctx.isPending(rep.ev), `replica ${r} is idle with an event pending`);
  } else if (rep.mode === MODE.kick) {
    check(work && rep.running.length === 0, `replica ${r} kick without new work`);
    check(ctx.isPending(rep.ev), `replica ${r} lost its kick`);
  } else {
    check(rep.mode === MODE.step || rep.mode === MODE.span, `replica ${r} mode ${rep.mode}`);
    // A step whose end falls after the day has no event; the day ends mid-step.
    check(ctx.isPending(rep.ev) || rep.t1 >= ctx.dayEndMs, `replica ${r} lost its step end`);
    check(rep.t0 <= ctx.nowMs && rep.t1 >= rep.t0, `replica ${r} step times`);
    if (rep.mode === MODE.span) {
      check(rep.spanSteps >= 1 && rep.spanDone < rep.spanSteps, `replica ${r} span counters`);
      check(rep.chunkSlot.length === 0, `replica ${r} span with prefill chunks`);
    }
  }
  const m = state.shared.meters.replica;
  check(m.running[r]!.value === rep.running.length, `replica ${r} running level`);
  check(m.waiting[r]!.value === waitingCount(rep), `replica ${r} waiting level`);
  check(m.kvUsed[r]!.value === kvUsedFrac(rep.pool), `replica ${r} kvUsed level`);
}

export function assertReplicaInvariants(state: DayState, ctx: Ctx): void {
  const sl = state.replica;
  const q = sl.req;
  const seen = new Uint8Array(q.capacity);
  for (let r = 0; r < sl.replicas.length; r++) {
    const rep = sl.replicas[r]!;
    check(rep.pool.blockSize === sl.limits.blockSize, `replica ${r} block size`);
    assertRequests(state, ctx, rep, r, seen);
    assertSchedule(state, ctx, rep, r);
  }
  for (let s = 0; s < q.capacity; s++) {
    check(
      (q.phase[s] !== PHASE.none) === (seen[s] === 1),
      `slot ${s} phase ${q.phase[s]} vs queues`,
    );
  }
}
