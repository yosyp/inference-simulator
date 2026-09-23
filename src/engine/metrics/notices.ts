// Lifecycle topics → open-bucket accumulators, histograms, records, and transitions (02 §11).
// Every handler is O(1) and runs at ctx.nowMs, which lies in the open bucket: the runner closes
// boundaries before any event at or after them. The metrics module is last in module order, so its
// subscribers see each notice after every other module has acted on it.
//
// Transition rows. requestState notices supply the middle states (waiting, prefill, decode,
// preempted). The metrics module writes the entry row (atRouter) at requestArrived and the terminal
// row at requestEnded itself, and ignores requestState notices for those states, so the rows come
// out the same whether or not the module that ends a request also announces its final state.

import { setLevel } from '../core/level.ts';
import type { Ctx, DayState, NoticeView } from '../core/types.ts';
import { HISTOGRAM_SPECS, binIndex, type HistogramMetric } from '../histogram.ts';
import { OUTCOME, REPLICA_STATE, REQUEST_STATE, type ReplicaState } from '../results.ts';
import { OUTCOME_PENDING, type RequestTable } from '../shared/requests.ts';
import { insertTransitionRow, pushRequestRow, pushTransitionRow } from './pending.ts';
import { METRIC_INDEX as MI, levelAreaAt, type MetricsSlice } from './slice.ts';

function fail(msg: string): never {
  throw new Error(`metrics: ${msg}`);
}

/** Records and transitions: every request under detail 'all', else only the tracked analyst's. */
export function inScope(ctx: Ctx, analyst: number): boolean {
  return ctx.input.detail === 'all' || analyst === ctx.input.trackedAnalyst;
}

function checkReplica(s: MetricsSlice, r: number, what: string): void {
  if (!(Number.isInteger(r) && r >= 0 && r < s.replicas))
    fail(`${what}: replica ${r} out of range`);
}

/** Adds a value to the open bucket for replica r (if r >= 0) and the fleet. */
function addBoth(s: MetricsSlice, metric: number, r: number, v: number): void {
  const series = s.replicas + 1;
  s.open[metric * series] += v;
  if (r >= 0) s.open[metric * series + r + 1] += v;
}

function histBoth(s: MetricsSlice, metric: HistogramMetric, r: number, valueMs: number): void {
  const spec = HISTOGRAM_SPECS[metric];
  const bin = binIndex(spec, valueMs);
  const h = s.openHist[metric];
  h[bin]! += 1;
  if (r >= 0) h[(r + 1) * spec.bins + bin]! += 1;
}

function writeTransition(
  s: MetricsSlice,
  row: number,
  atMs: number,
  t: RequestTable,
  slot: number,
  state: number,
): void {
  const b = s.transitions;
  b.atMs[row] = atMs;
  b.request[row] = t.id[slot]!;
  b.analyst[row] = t.analyst[slot]!;
  b.replica[row] = t.replica[slot]!;
  b.state[row] = state;
}

/** First row for request `id` among the rows written at atMs (the tail), or count if none. */
function firstRowNow(s: MetricsSlice, id: number, atMs: number): number {
  const b = s.transitions;
  let first = b.count;
  for (let k = b.count - 1; k >= 0 && b.atMs[k] === atMs; k--) if (b.request[k] === id) first = k;
  return first;
}

export function onArrived(state: DayState, n: Readonly<NoticeView>, ctx: Ctx): void {
  const s = state.metrics;
  const t = state.shared.requests;
  const slot = n.a;
  const series = s.replicas + 1;
  s.open[MI.offered * series] += 1;
  s.open[(t.attempt[slot] === 0 ? MI.organic : MI.retries) * series] += 1;
  s.day.arrived++;
  if (!inScope(ctx, t.analyst[slot]!)) return;
  // A request can end inside this very notice (admission control rejects it in an earlier
  // subscriber); its end row is already written, so put the arrival row before it.
  const row =
    t.outcome[slot] === OUTCOME_PENDING
      ? pushTransitionRow(s)
      : insertTransitionRow(s, firstRowNow(s, t.id[slot]!, ctx.nowMs));
  writeTransition(s, row, ctx.nowMs, t, slot, REQUEST_STATE.atRouter);
}

export function onDispatched(state: DayState, n: Readonly<NoticeView>): void {
  const s = state.metrics;
  checkReplica(s, n.b, 'requestDispatched');
  addBoth(s, MI.dispatched, n.b, 1);
}

export function onFirstToken(state: DayState, n: Readonly<NoticeView>, ctx: Ctx): void {
  const s = state.metrics;
  const t = state.shared.requests;
  const slot = n.a;
  const r = n.b;
  checkReplica(s, r, 'firstToken');
  const first = t.firstTokenMs[slot]!;
  const ttft = (Number.isFinite(first) ? first : ctx.nowMs) - t.arriveMs[slot]!;
  addBoth(s, MI.ttftSumMs, r, ttft);
  addBoth(s, MI.ttftCount, r, 1);
  histBoth(s, 'ttft', r, ttft);
}

const OUTCOME_METRIC: Record<number, number> = {
  [OUTCOME.finished]: MI.finished,
  [OUTCOME.rejected]: MI.rejected,
  [OUTCOME.timedOut]: MI.timedOut,
  [OUTCOME.failed]: MI.failed,
};
const OUTCOME_TOTAL = {
  [OUTCOME.finished]: 'finished',
  [OUTCOME.rejected]: 'rejected',
  [OUTCOME.timedOut]: 'timedOut',
  [OUTCOME.failed]: 'failed',
} as const;

export function onEnded(state: DayState, n: Readonly<NoticeView>, ctx: Ctx): void {
  const s = state.metrics;
  const t = state.shared.requests;
  const slot = n.a;
  const outcome = n.b as keyof typeof OUTCOME_TOTAL;
  const metric = OUTCOME_METRIC[outcome];
  if (metric === undefined) fail(`requestEnded with outcome ${outcome}`);
  // The shared module (first in order) released the slot for this notice; the fields stay readable.
  if (t.live[slot] !== 2) fail(`requestEnded for slot ${slot}, which is not ending`);
  const r = t.replica[slot]!;
  if (r >= s.replicas) fail(`requestEnded: replica ${r} out of range`);
  // Rejected is fleet-only: a rejected request never reached a replica.
  addBoth(s, metric, outcome === OUTCOME.rejected ? -1 : r, 1);
  s.day[OUTCOME_TOTAL[outcome]]++;
  const endRaw = t.endMs[slot]!;
  const end = Number.isFinite(endRaw) ? endRaw : ctx.nowMs;

  if (outcome === OUTCOME.finished) {
    const e2e = end - t.arriveMs[slot]!;
    addBoth(s, MI.e2eSumMs, r, e2e);
    addBoth(s, MI.e2eCount, r, 1);
    histBoth(s, 'e2e', r, e2e);
    if (r >= 0) {
      s.served[r]! += 1;
      s.servedE2eMs[r]! += e2e;
    }
    // TPOT only for finished requests: endMs is their last token's time. For a failed request
    // it is the crash time, which would inflate the mean gap.
    const first = t.firstTokenMs[slot]!;
    const out = t.outputDone[slot]!;
    if (out >= 2 && Number.isFinite(first)) {
      const tpot = (end - first) / (out - 1);
      addBoth(s, MI.tpotSumMs, r, tpot);
      addBoth(s, MI.tpotCount, r, 1);
      histBoth(s, 'tpot', r, tpot);
    }
  }

  if (!inScope(ctx, t.analyst[slot]!)) return;
  const k = pushRequestRow(s);
  const b = s.requests;
  b.id[k] = t.id[slot]!;
  b.session[k] = t.session[slot]!;
  b.analyst[k] = t.analyst[slot]!;
  b.turn[k] = t.turn[slot]!;
  b.attempt[k] = t.attempt[slot]!;
  b.replica[k] = r;
  b.prevReplica[k] = t.prevReplica[slot]!;
  b.arriveMs[k] = t.arriveMs[slot]!;
  b.dispatchMs[k] = t.dispatchMs[slot]!;
  b.firstTokenMs[k] = t.firstTokenMs[slot]!;
  b.endMs[k] = end;
  b.promptTokens[k] = t.promptTokens[slot]!;
  b.cachedTokens[k] = t.cachedTokens[slot]!;
  b.outputTokens[k] = t.outputDone[slot]!;
  b.preemptions[k] = t.preemptions[slot]!;
  b.outcome[k] = outcome;
  // OUTCOME codes are the terminal REQUEST_STATE codes.
  writeTransition(s, pushTransitionRow(s), ctx.nowMs, t, slot, outcome);
}

export function onRequestState(state: DayState, n: Readonly<NoticeView>, ctx: Ctx): void {
  const st = n.b;
  if (st === REQUEST_STATE.atRouter || st >= REQUEST_STATE.finished) return;
  const s = state.metrics;
  const t = state.shared.requests;
  if (!inScope(ctx, t.analyst[n.a]!)) return;
  writeTransition(s, pushTransitionRow(s), ctx.nowMs, t, n.a, st);
}

/**
 * Replica events, the Ready count, and the Ready-time integral of each replica's kvUsed level
 * (fleet kvUsedFrac is the mean over Ready replica-time).
 */
export function onReplicaState(state: DayState, n: Readonly<NoticeView>, ctx: Ctx): void {
  const s = state.metrics;
  const r = n.a;
  const st = n.b;
  checkReplica(s, r, 'replicaState');
  if (!Object.values(REPLICA_STATE).includes(st as never)) fail(`replicaState ${st}`);
  const now = ctx.nowMs;
  s.replicaEvents.push({
    atMs: now,
    replica: r,
    state: st as ReplicaState,
  });
  const was = s.ready[r] === 1;
  const is = st === REPLICA_STATE.ready;
  if (was === is) return;
  const kv = state.shared.meters.replica.kvUsed[r]!;
  if (was) {
    s.readyKvArea[r]! += levelAreaAt(kv, now) - s.markArea[r]!;
    s.readyMs[r]! += now - s.markMs[r]!;
  } else {
    s.markArea[r] = levelAreaAt(kv, now);
    s.markMs[r] = now;
  }
  s.ready[r] = is ? 1 : 0;
  setLevel(s.readyCount, now, s.readyCount.value + (is ? 1 : -1));
}
