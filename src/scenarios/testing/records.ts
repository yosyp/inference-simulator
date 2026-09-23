// Helpers over per-request records (run.ts RequestRecord): exact per-request statistics for the
// lessons that need them (tab 1's long prompt, tab 4's returning turns, tab 5's moved sessions).
// Records exist for every request only under detail 'all' (runScenarioDay's default).

import { OUTCOME } from '../../engine/results.ts';
import type { SimMs } from '../../engine/time.ts';
import type { LatencyStats } from './lessons.ts';
import type { RequestRecord } from './run.ts';
import type { TimeWindow } from './window.ts';

export type RecordFilter = (r: RequestRecord) => boolean;

export const anyRecord: RecordFilter = () => true;

/** Turn 2 or later: the session's history may be cached. */
export const isReturning: RecordFilter = (r) => r.turn >= 2;

export const isFinished: RecordFilter = (r) => r.outcome === OUTCOME.finished;

/** Arrived at the router inside the window. */
export function arrivedIn(window: TimeWindow): RecordFilter {
  return (r) => r.arriveMs >= window.fromMs && r.arriveMs < window.toMs;
}

/** Dispatched to replica r (retries included). */
export function onReplica(replica: number): RecordFilter {
  return (r) => r.replica === replica;
}

export function allOf(...filters: RecordFilter[]): RecordFilter {
  return (r) => filters.every((f) => f(r));
}

/**
 * TTFT: first token − arrival (NaN without a first token). TPOT: (end − first token) ÷ (output − 1)
 * for finished requests with 2+ output tokens. E2E: end − arrival, finished only. Matches U8's
 * requestPoints.
 */
export function requestMetricMs(r: RequestRecord, metric: 'ttft' | 'tpot' | 'e2e'): number {
  const finished = r.outcome === OUTCOME.finished;
  if (metric === 'ttft') return r.firstTokenMs - r.arriveMs;
  if (metric === 'tpot') {
    return finished && r.outputTokens >= 2
      ? (r.endMs - r.firstTokenMs) / (r.outputTokens - 1)
      : NaN;
  }
  return finished ? r.endMs - r.arriveMs : NaN;
}

/** Linear-interpolated quantile of ascending values (d3.quantileSorted's rule); NaN if empty. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Exact stats of a latency over the records passing the filter that have it (not NaN). */
export function recordStats(
  records: readonly RequestRecord[],
  metric: 'ttft' | 'tpot' | 'e2e',
  filter: RecordFilter = anyRecord,
): LatencyStats {
  const vs: number[] = [];
  for (const r of records) {
    if (!filter(r)) continue;
    const v = requestMetricMs(r, metric);
    if (!Number.isNaN(v)) vs.push(v);
  }
  vs.sort((a, b) => a - b);
  const sum = vs.reduce((a, b) => a + b, 0);
  return {
    count: vs.length,
    meanMs: vs.length > 0 ? sum / vs.length : NaN,
    p50Ms: quantileSorted(vs, 0.5),
    p99Ms: quantileSorted(vs, 0.99),
  };
}

export interface HitRate {
  /** Σ cached prompt tokens ÷ Σ prompt tokens. */
  hitRate: number;
  requests: number;
}

/**
 * Prefix-cache hit rate of returning turns (turn >= 2) that reached a replica, token-weighted
 * like the chart's returningHitTokens ÷ returningQueryTokens. Tab 4: ≥ 0.7 under affinity,
 * about 1/N under round-robin.
 */
export function returningTurnHitRate(
  records: readonly RequestRecord[],
  filter: RecordFilter = anyRecord,
): HitRate {
  let cached = 0;
  let prompt = 0;
  let requests = 0;
  for (const r of records) {
    if (r.turn < 2 || r.replica < 0 || !filter(r)) continue;
    cached += r.cachedTokens;
    prompt += r.promptTokens;
    requests++;
  }
  return { hitRate: prompt > 0 ? cached / prompt : NaN, requests };
}

/** TTFT stats of returning turns (turn >= 2) passing the filter. */
export function returningTurnTtft(
  records: readonly RequestRecord[],
  filter: RecordFilter = anyRecord,
): LatencyStats {
  return recordStats(records, 'ttft', (r) => r.turn >= 2 && filter(r));
}

export interface SessionsMoved {
  /** Sessions with a finished returning turn arriving at or after afterMs. */
  sessions: number;
  /** Of those, how many landed on a different replica than their previous turn. */
  moved: number;
  /** moved ÷ sessions; NaN if none. */
  fraction: number;
}

/**
 * The fraction of returning sessions whose next turn landed on a different replica than their
 * previous turn (tab 5: ≥ 0.8 under mod-N, ≤ 0.2 under consistent hashing). Per session, the
 * "next turn" is its earliest-arriving finished request with turn >= 2 arriving at or after
 * afterMs; attempts that failed on a crashed replica or timed out don't count, the retry that
 * finished does.
 */
export function sessionsMoved(
  records: readonly RequestRecord[],
  afterMs: SimMs,
  filter: RecordFilter = anyRecord,
): SessionsMoved {
  const next = new Map<number, RequestRecord>();
  for (const r of records) {
    if (r.turn < 2 || r.prevReplica < 0 || r.arriveMs < afterMs) continue;
    if (r.outcome !== OUTCOME.finished || !filter(r)) continue;
    const seen = next.get(r.session);
    if (!seen || r.arriveMs < seen.arriveMs) next.set(r.session, r);
  }
  let moved = 0;
  for (const r of next.values()) if (r.replica !== r.prevReplica) moved++;
  const sessions = next.size;
  return { sessions, moved, fraction: sessions > 0 ? moved / sessions : NaN };
}
