// The canvas scene (05 §7) and the live status line's snapshot (05 §8) at one instant. Levels come
// from the scalar bucket containing t; rates from the minute of buckets ending with it.

import type { AnalystId } from '../../engine/api.ts';
import { HISTOGRAM_SPECS, addSparseCellInto, quantile } from '../../engine/histogram.ts';
import {
  FLEET_SERIES,
  REPLICA_STATE,
  REQUEST_STATE,
  replicaSeries,
  type HistogramBlock,
  type ReplicaEvent,
  type ReplicaState,
  type ScalarBlock,
  type ScalarMetric,
} from '../../engine/results.ts';
import { DAY_MS, MINUTE_MS, WEEK_DAYS, type SimMs } from '../../engine/time.ts';
import { quietScalar } from '../../engine/metrics/quiet.ts';
import type {
  DotView,
  Mode,
  ReplicaSnapshot,
  ReplicaView,
  SceneState,
  StatusSnapshot,
} from '../types.ts';
import { dotStreamAt, type DayData } from './day.ts';
import { activeAt } from './dots.ts';
import { DOT_STATE, trackedView } from './records.ts';
import { bucketIn, entryAt, forEachRun, isQuietAt, type SlotIndex } from './slots.ts';

export interface StoreState {
  replicas: number;
  /** Peak dense FLOPS of one replica's GPU, for compute utilization. */
  peakFlops: number;
  scal: SlotIndex<ScalarBlock>;
  hist: SlotIndex<HistogramBlock>;
  days: (DayData | null)[];
}

function dayAt(state: StoreState, t: SimMs): DayData | null {
  const d = Math.floor(t / DAY_MS);
  return d >= 0 && d < WEEK_DAYS ? (state.days[d] ?? null) : null;
}

/** Scalar buckets for one instant: the bucket containing t, and the minute ending with it. */
class Around {
  private readonly index: SlotIndex<ScalarBlock>;
  readonly g: number;
  readonly g0: number;
  constructor(index: SlotIndex<ScalarBlock>, t: SimMs) {
    this.index = index;
    const bucketMs = index.bucketMs;
    if (bucketMs === 0) {
      // No buckets yet: an empty window, so every level and rate is NaN.
      this.g = -1;
      this.g0 = 0;
      return;
    }
    this.g = Math.floor(t / bucketMs);
    const dayFirst = Math.floor(t / DAY_MS) * index.slotsPerDay;
    this.g0 = Math.max(dayFirst, this.g - Math.max(1, Math.round(MINUTE_MS / bucketMs)) + 1);
  }

  /** A QUIET bucket's value (slots.ts), NaN for a series the fleet doesn't have. */
  private quiet(metric: ScalarMetric, series: number): number {
    const replicas = this.index.series - 1;
    return series >= 0 && series <= replicas ? quietScalar(metric, series, replicas) : NaN;
  }

  /** The metric in the bucket containing t, or NaN. */
  level(metric: ScalarMetric, series: number): number {
    const e = entryAt(this.index, this.g);
    if (!e) return isQuietAt(this.index, this.g) ? this.quiet(metric, series) : NaN;
    if (series >= e.block.series) return NaN;
    return e.block.data[metric][bucketIn(this.index, e, this.g) * e.block.series + series]!;
  }

  /** Sum over slots [from, g] and the milliseconds of buckets present. */
  sum(metric: ScalarMetric, series: number, from = this.g0): { sum: number; ms: number } {
    let sum = 0;
    let n = 0;
    forEachRun(this.index, from, this.g + 1, (block, bucket, count) => {
      if (!block) {
        const q = this.quiet(metric, series);
        if (Number.isNaN(q)) return;
        sum += q * count;
        n += count;
        return;
      }
      if (series >= block.series) return;
      const data = block.data[metric];
      for (let k = 0, i = bucket * block.series + series; k < count; k++, i += block.series) {
        sum += data[i]!;
      }
      n += count;
    });
    return { sum, ms: n * this.index.bucketMs };
  }

  /** Per-second rate over the trailing minute (only buckets present count toward its length). */
  perS(metric: ScalarMetric, series: number): number {
    const { sum, ms } = this.sum(metric, series);
    return ms > 0 ? (sum * 1000) / ms : NaN;
  }

  /** Cumulative since the day's start. */
  sinceDayStart(metric: ScalarMetric, series: number): number {
    const dayFirst = Math.floor(this.g / this.index.slotsPerDay) * this.index.slotsPerDay;
    const { sum, ms } = this.sum(metric, series, dayFirst);
    return ms > 0 ? sum : NaN;
  }
}

function replicaPhase(
  events: readonly ReplicaEvent[],
  replica: number,
  t: SimMs,
): { state: ReplicaState; phaseProgress: number | null } {
  let state: ReplicaState = REPLICA_STATE.ready;
  let since = -Infinity;
  let next = Infinity;
  for (const e of events) {
    if (e.replica !== replica) continue;
    if (e.atMs <= t) {
      state = e.state;
      since = e.atMs;
    } else {
      next = e.atMs;
      break;
    }
  }
  const loading =
    state === REPLICA_STATE.loadingWeights || state === REPLICA_STATE.initializingEngine;
  if (!loading) return { state, phaseProgress: null };
  // The phase's end is unknown until the next event is computed.
  const progress = next < Infinity ? (t - since) / (next - since) : 0;
  return { state, phaseProgress: Math.min(1, Math.max(0, progress)) };
}

function replicaSnapshot(
  state: StoreState,
  around: Around,
  events: readonly ReplicaEvent[],
  replica: number,
  t: SimMs,
): ReplicaSnapshot {
  const s = replicaSeries(replica);
  const busy = around.sum('busyMs', s);
  const flops = around.sum('flops', s);
  return {
    replica,
    ...replicaPhase(events, replica, t),
    kvUsedFrac: around.level('kvUsedFrac', s),
    running: around.level('running', s),
    waiting: around.level('waiting', s),
    preemptionsPerMin: around.perS('preemptions', s) * 60,
    prefillTokensPerS: around.perS('prefillTokens', s),
    decodeTokensPerS: around.perS('decodeTokens', s),
    nvidiaSmiUtil: busy.ms > 0 ? busy.sum / busy.ms : NaN,
    computeUtil: flops.ms > 0 ? flops.sum / ((state.peakFlops * flops.ms) / 1000) : NaN,
  };
}

function replicaSnapshots(state: StoreState, around: Around, t: SimMs): ReplicaSnapshot[] {
  const events = dayAt(state, t)?.events ?? [];
  const out: ReplicaSnapshot[] = [];
  for (let r = 0; r < state.replicas; r++) out.push(replicaSnapshot(state, around, events, r, t));
  return out;
}

function ttftP99At(hist: SlotIndex<HistogramBlock>, t: SimMs): number {
  if (hist.bucketMs === 0) return NaN;
  const g = Math.floor(t / hist.bucketMs);
  const e = entryAt(hist, g);
  const spec = HISTOGRAM_SPECS.ttft;
  // A QUIET bucket is computed and empty: the quantile of no samples.
  if (!e) return isQuietAt(hist, g) ? quantile(spec, new Uint32Array(spec.bins), 0, 0.99) : NaN;
  const scratch = new Uint32Array(spec.bins);
  addSparseCellInto(
    scratch,
    0,
    e.block.data.ttft,
    bucketIn(hist, e, g) * e.block.series + FLEET_SERIES,
  );
  return quantile(spec, scratch, 0, 0.99);
}

/**
 * Status at t. Levels are from the scalar bucket containing t; rates are per second over the
 * minute of buckets ending with it; ttftP99Ms is from the histogram bucket containing t;
 * abandonedSessions counts from the day's start. NaN marks missing data.
 */
export function statusAt(state: StoreState, t: SimMs): StatusSnapshot {
  const around = new Around(state.scal, t);
  const offered = around.sum('offered', FLEET_SERIES);
  const organic = around.sum('organic', FLEET_SERIES);
  let amplification = NaN;
  if (organic.sum > 0) amplification = offered.sum / organic.sum;
  else if (organic.ms > 0 && offered.sum === 0) amplification = 1;
  return {
    atMs: t,
    replicas: replicaSnapshots(state, around, t),
    fleet: {
      offeredPerS: around.perS('offered', FLEET_SERIES),
      admittedPerS: around.perS('dispatched', FLEET_SERIES),
      rejectedPerS: around.perS('rejected', FLEET_SERIES),
      amplification,
      ttftP99Ms: ttftP99At(state.hist, t),
      abandonedSessions: around.sinceDayStart('abandonedSessions', FLEET_SERIES),
      finishedPerS: around.perS('finished', FLEET_SERIES),
    },
  };
}

/**
 * The canvas scene at t. Dots appear only in live dot mode where scope-'all' transitions cover t;
 * otherwise detail is 'aggregate' and the engine client should request detail. The tracked
 * analyst's requests always come from tracked-scope data.
 */
export function sceneAt(
  state: StoreState,
  t: SimMs,
  opts: { mode: Mode; detail: 'dots' | 'aggregate'; trackedAnalyst: AnalystId | null },
): SceneState {
  const around = new Around(state.scal, t);
  const replicas: ReplicaView[] = replicaSnapshots(state, around, t).map((s) => ({
    ...s,
    dots: [],
  }));
  const atRouter: DotView[] = [];
  const dd = dayAt(state, t);
  const stream = opts.detail === 'dots' && opts.mode === 'live' && dd ? dotStreamAt(dd, t) : null;
  if (stream) {
    activeAt(stream, t, (tb, k, progress) => {
      const code = tb.state[k]!;
      const analyst = tb.analyst[k]!;
      const dot: DotView = {
        request: tb.request[k]!,
        analyst,
        state: DOT_STATE[code] ?? 'queued',
        progress,
        tracked: analyst === opts.trackedAnalyst,
      };
      const r = tb.replica[k]!;
      if (code === REQUEST_STATE.atRouter || r < 0) atRouter.push(dot);
      else replicas[r]?.dots.push(dot);
    });
    const byRequest = (a: DotView, b: DotView) => a.request - b.request;
    atRouter.sort(byRequest);
    for (const r of replicas) r.dots.sort(byRequest);
  }
  return {
    atMs: t,
    mode: opts.mode,
    detail: stream ? 'dots' : 'aggregate',
    router: { atRouter, offeredPerS: around.perS('offered', FLEET_SERIES) },
    replicas,
    tracked:
      opts.trackedAnalyst === null
        ? null
        : { analyst: opts.trackedAnalyst, requests: trackedView(dd, opts.trackedAnalyst, t) },
  };
}
