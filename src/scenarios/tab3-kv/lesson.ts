// Tab 3's lesson numbers from a headless run of its lesson day (00-build §7.3), shared by
// lessons.test.ts and handy from a REPL: `lessonNumbers(runScenarioDay(scenario, ...))`.

import { MINUTE_MS, type SimMs } from '../../engine/time.ts';
import {
  isFinished,
  isReturning,
  longestRun,
  preemptionsIn,
  recomputedPrefillShare,
  scalarIn,
  slide,
  ttftStatsInWindow,
  utilizationIn,
  win,
  type RequestRecord,
  type ScenarioDayResult,
  type TimeWindow,
} from '../testing/index.ts';

/** The pool counts as full at this 1-minute mean KV use (see lessons.test.ts for why not 95%). */
export const KV_FULL = 0.9;

/** How long after the moment to look for the plateau. */
export const SEARCH_MS = 90 * MINUTE_MS;

export interface Tab3Lesson {
  /** The longest stretch where the 1-minute mean KV use is at least KV_FULL. */
  plateau: TimeWindow | null;
  plateauMs: number;
  kvMaxInPlateau: number;
  preemptions: number;
  /** Recomputed after preemption ÷ all prefill tokens, in the plateau. */
  preemptRecomputeShare: number;
  /**
   * Returning turns whose first token lands in the plateau: history the GPU had computed on the
   * previous turn (its prompt + output) but no longer had cached, ÷ all prefill tokens in the
   * plateau.
   */
  historyRecomputeShare: number;
  nvidiaSmi: number;
  compute: number;
  ttftP99BeforeMs: number;
  ttftP99PlateauMs: number;
  ttftMeanPlateauMs: number;
  /** Requests served per minute in the plateau and in the 10 minutes before it. */
  servedPerMinPlateau: number;
  servedPerMinLeadIn: number;
}

function perMin(run: ScenarioDayResult, w: TimeWindow): number {
  return scalarIn(run, 'finished', w) / ((w.toMs - w.fromMs) / MINUTE_MS);
}

/** Paid-for history re-prefilled by returning turns whose first token lands in the window. */
function historyRecomputed(records: readonly RequestRecord[], w: TimeWindow): number {
  const context = new Map<string, number>();
  for (const r of records) {
    if (isFinished(r)) context.set(`${r.session}:${r.turn}`, r.promptTokens + r.outputTokens);
  }
  let tokens = 0;
  for (const r of records) {
    if (!isFinished(r) || !isReturning(r)) continue;
    if (!(r.firstTokenMs >= w.fromMs && r.firstTokenMs < w.toMs)) continue;
    const prev = context.get(`${r.session}:${r.turn - 1}`);
    if (prev !== undefined) tokens += Math.max(0, prev - r.cachedTokens);
  }
  return tokens;
}

export function lessonNumbers(run: ScenarioDayResult, momentMs: SimMs = run.momentMs): Tab3Lesson {
  const kv = slide(win(momentMs, momentMs + SEARCH_MS), MINUTE_MS, (w) =>
    scalarIn(run, 'kvUsedFrac', w),
  );
  const { window: plateau, ms: plateauMs } = longestRun(kv, (v) => v >= KV_FULL);
  const p = plateau ?? win(momentMs, momentMs);
  const before = win(momentMs - 30 * MINUTE_MS, momentMs);
  const leadIn = win(p.fromMs - 10 * MINUTE_MS, p.fromMs);
  const util = utilizationIn(run, p);
  const plateauTtft = ttftStatsInWindow(run, p);
  const prefill = scalarIn(run, 'prefillTokens', p);
  return {
    plateau,
    plateauMs,
    kvMaxInPlateau: scalarIn(run, 'kvUsedFracMax', p),
    preemptions: preemptionsIn(run, p),
    preemptRecomputeShare: recomputedPrefillShare(run, p),
    historyRecomputeShare: prefill > 0 ? historyRecomputed(run.records, p) / prefill : NaN,
    nvidiaSmi: util.nvidiaSmi,
    compute: util.compute,
    ttftP99BeforeMs: ttftStatsInWindow(run, before).p99Ms,
    ttftP99PlateauMs: plateauTtft.p99Ms,
    ttftMeanPlateauMs: plateauTtft.meanMs,
    servedPerMinPlateau: perMin(run, p),
    servedPerMinLeadIn: perMin(run, leadIn),
  };
}
