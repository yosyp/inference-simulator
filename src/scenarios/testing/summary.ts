// The lesson summary pnpm sim prints (C1): the lesson numbers in a window before and after the
// lesson moment, plus per-replica load after it.

import { replicaSeries } from '../../engine/results.ts';
import { DAY_MS, MINUTE_MS } from '../../engine/time.ts';
import {
  amplification,
  goodputShare,
  hitRatesIn,
  kvAtLeastForMs,
  preemptionsIn,
  recomputedPrefillShare,
  replicaLoadImbalance,
  requestCountsIn,
  throughputTokensPerS,
  ttftStatsInWindow,
  utilizationIn,
  type LatencyStats,
  type RequestCounts,
} from './lessons.ts';
import {
  allOf,
  arrivedIn,
  onReplica,
  returningTurnHitRate,
  returningTurnTtft,
  sessionsMoved,
} from './records.ts';
import type { ScenarioDayResult } from './run.ts';
import { entryToMomentWallS, formatSimMs } from './scenario.ts';
import { after, before, scalarIn, scalarWindow, type TimeWindow } from './window.ts';

export interface WindowSummary {
  window: TimeWindow;
  ttft: LatencyStats;
  /** Returning turns (turn >= 2) arriving in the window, from records. */
  returningTtft: LatencyStats;
  kvMeanPct: number;
  kvMaxPct: number;
  kvAtLeast95Ms: number;
  preemptions: number;
  recomputedPrefillPct: number;
  nvidiaSmiPct: number;
  computePct: number;
  decodeTokPerS: number;
  prefixHitPct: number;
  returningHitPct: number;
  amplification: number;
  goodputPct: number;
  /** Router outstanding: max ÷ mean over replicas (1 = balanced). */
  imbalance: number;
  counts: RequestCounts;
}

export interface ReplicaSummary {
  replica: number;
  outstanding: number;
  kvMeanPct: number;
  nvidiaSmiPct: number;
  ttftP99Ms: number;
  returningHitPct: number;
  finished: number;
}

export interface LessonSummary {
  id: string;
  tab: number;
  title: string;
  preset: string;
  replicas: number;
  day: number;
  moment: string;
  momentLabel: string;
  /** Patches beyond the baseline. */
  extraPatches: number;
  detail: 'all' | 'tracked';
  simulatedTo: string;
  wallS: number;
  entryToMomentWallS: number;
  before: WindowSummary;
  after: WindowSummary;
  /** Returning sessions whose next turn after the moment changed replica. */
  sessionsMoved: { sessions: number; moved: number; fraction: number };
  perReplica: ReplicaSummary[];
}

const pct = (x: number) => x * 100;

function windowSummary(r: ScenarioDayResult, w: TimeWindow): WindowSummary {
  const util = utilizationIn(r, w);
  const hits = hitRatesIn(r, w);
  return {
    window: w,
    ttft: ttftStatsInWindow(r, w),
    returningTtft: returningTurnTtft(r.records, arrivedIn(w)),
    kvMeanPct: pct(scalarIn(r, 'kvUsedFrac', w)),
    kvMaxPct: pct(scalarIn(r, 'kvUsedFracMax', w)),
    kvAtLeast95Ms: kvAtLeastForMs(r, 0.95, w).ms,
    preemptions: preemptionsIn(r, w),
    recomputedPrefillPct: pct(recomputedPrefillShare(r, w)),
    nvidiaSmiPct: pct(util.nvidiaSmi),
    computePct: pct(util.compute),
    decodeTokPerS: throughputTokensPerS(r, w).decodePerS,
    prefixHitPct: pct(hits.prefix),
    returningHitPct: pct(hits.returning),
    amplification: amplification(r, w),
    goodputPct: pct(goodputShare(r, w)),
    imbalance: replicaLoadImbalance(r, w).ratio,
    counts: requestCountsIn(r, w),
  };
}

/** Summarizes the run around its lesson moment, windowMs (default 15 minutes) on each side. */
export function lessonSummary(
  r: ScenarioDayResult,
  windowMs: number = 15 * MINUTE_MS,
): LessonSummary {
  const s = r.scenario;
  const b = before(r.momentMs, windowMs);
  const a = after(r.momentMs, windowMs);
  const perReplica = Array.from({ length: r.replicas }, (_, i): ReplicaSummary => {
    const series = replicaSeries(i);
    return {
      replica: i,
      outstanding: scalarIn(r, 'outstanding', a, series),
      kvMeanPct: pct(scalarIn(r, 'kvUsedFrac', a, series)),
      nvidiaSmiPct: pct(utilizationIn(r, a, series).nvidiaSmi),
      ttftP99Ms: ttftStatsInWindow(r, a, series).p99Ms,
      returningHitPct: pct(
        returningTurnHitRate(r.records, allOf(onReplica(i), arrivedIn(a))).hitRate,
      ),
      finished: scalarWindow(r, 'finished', a, series).value || 0,
    };
  });
  return {
    id: s.id,
    tab: s.tab,
    title: s.title,
    preset: s.preset.name,
    replicas: r.replicas,
    day: r.day,
    moment: formatSimMs(r.momentMs),
    momentLabel: s.lessonMoment.label,
    extraPatches: r.patches.length - s.baselinePatches.length,
    detail: r.detail,
    simulatedTo: formatSimMs(r.day * DAY_MS + r.simMs),
    wallS: r.wallMs / 1000,
    entryToMomentWallS: entryToMomentWallS(s),
    before: windowSummary(r, b),
    after: windowSummary(r, a),
    sessionsMoved: sessionsMoved(r.records, r.momentMs),
    perReplica,
  };
}

function fmt(x: number, digits = 0): string {
  if (Number.isNaN(x)) return '–';
  return x.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** A plain-text table of the summary. */
export function formatSummary(s: LessonSummary): string {
  const rows: [string, (w: WindowSummary) => string][] = [
    ['TTFT mean ms', (w) => fmt(w.ttft.meanMs)],
    ['TTFT p50 ms', (w) => fmt(w.ttft.p50Ms)],
    ['TTFT p99 ms', (w) => fmt(w.ttft.p99Ms)],
    ['returning-turn TTFT p50 ms', (w) => fmt(w.returningTtft.p50Ms)],
    ['KV mean / max %', (w) => `${fmt(w.kvMeanPct)} / ${fmt(w.kvMaxPct)}`],
    ['KV >= 95% for (min)', (w) => fmt(w.kvAtLeast95Ms / MINUTE_MS, 1)],
    ['preemptions', (w) => fmt(w.preemptions)],
    ['recomputed prefill %', (w) => fmt(w.recomputedPrefillPct, 1)],
    ['util nvidia-smi / compute %', (w) => `${fmt(w.nvidiaSmiPct)} / ${fmt(w.computePct)}`],
    ['decode tokens/s', (w) => fmt(w.decodeTokPerS)],
    ['hit rate prefix / returning %', (w) => `${fmt(w.prefixHitPct)} / ${fmt(w.returningHitPct)}`],
    ['amplification', (w) => fmt(w.amplification, 2)],
    ['goodput % of organic', (w) => fmt(w.goodputPct)],
    ['load imbalance (max/mean)', (w) => fmt(w.imbalance, 2)],
    [
      'finished / timed out / rejected / failed',
      (w) =>
        [w.counts.finished, w.counts.timedOut, w.counts.rejected, w.counts.failed]
          .map((n) => fmt(n))
          .join(' / '),
    ],
  ];
  const span = (w: TimeWindow) => `${formatSimMs(w.fromMs)}–${formatSimMs(w.toMs).slice(4)}`;
  const table: string[][] = [
    ['', `before ${span(s.before.window)}`, `after ${span(s.after.window)}`],
    ...rows.map(([label, f]) => [label, f(s.before), f(s.after)]),
  ];
  const widths = [0, 1, 2].map((c) => Math.max(...table.map((r) => r[c]!.length)));
  const line = (r: string[]) =>
    `  ${r[0]!.padEnd(widths[0]!)}  ${r[1]!.padStart(widths[1]!)}  ${r[2]!.padStart(widths[2]!)}`;
  const moved = s.sessionsMoved;
  const out = [
    `Tab ${s.tab} ${s.id} (${s.title}) · ${s.preset}, ${s.replicas} replica(s) · detail ${s.detail}`,
    `  lesson moment ${s.moment}: ${s.momentLabel}`,
    `  simulated to ${s.simulatedTo} in ${fmt(s.wallS, 1)} s wall` +
      (s.extraPatches > 0 ? ` · ${s.extraPatches} extra patch(es)` : '') +
      ` · entry→moment ${fmt(s.entryToMomentWallS, 1)} s wall`,
    ...table.map(line),
    `  sessions moved after the moment: ${fmt(moved.fraction * 100)}% (${moved.moved}/${moved.sessions})`,
    `  per replica, after:  outstanding  KV %  util %  TTFT p99 ms  returning hit %  finished`,
    ...s.perReplica.map(
      (p) =>
        `    replica ${String(p.replica + 1).padEnd(3)}  ${fmt(p.outstanding, 1).padStart(11)}  ` +
        `${fmt(p.kvMeanPct).padStart(4)}  ${fmt(p.nvidiaSmiPct).padStart(6)}  ` +
        `${fmt(p.ttftP99Ms).padStart(11)}  ${fmt(p.returningHitPct).padStart(15)}  ${fmt(p.finished).padStart(8)}`,
    ),
  ];
  return out.join('\n');
}
