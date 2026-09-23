// Tab 6 lesson assertions (00-build §7.3, refined with evidence). Runs Wednesday headless to 15
// minutes past the crash three times: with no crash (the organic demand), the baseline week (the
// crash with immediate retries), and the named fix applied at the entry point.
//
// §7.3 proposed "goodput < 50% of organic demand for ≥ 10 minutes" and, with the fix,
// "amplification ≤ 1.3×". In this model the storm lasts about as long as the outage (the
// replacement is Ready 125 s after the crash), because analysts abandon conversations once their
// retries run out (K8) and that sheds load. And with the fix, clients still retry rejected
// requests, so offered load is ~2× first attempts during the outage too; what the fix holds down is
// admitted load, the work that reaches the GPUs. The thresholds below follow that.

import { describe, expect, it } from 'vitest';
import type { Patch } from '../../engine/api.ts';
import { HISTOGRAM_SPECS, quantile } from '../../engine/histogram.ts';
import { HOUR_MS, MINUTE_MS, dayOf, timeOfDayMs } from '../../engine/time.ts';
import {
  entryToMomentWallS,
  histogramIn,
  readyAtOrAfter,
  requestCountsIn,
  runScenarioDay,
  win,
  type RequestCounts,
  type ScenarioDayResult,
} from '../testing/index.ts';
import { CRASHED_REPLICA, FIX_ADMISSION_LIMIT, LESSON_MOMENT_MS, scenario } from './index.ts';

const C = LESSON_MOMENT_MS;
const UNTIL = timeOfDayMs(C) + 15 * MINUTE_MS;
const TIMEOUT = 60_000;

function run(baselinePatches: Patch[], patches: Patch[] = []): ScenarioDayResult {
  return runScenarioDay(
    { ...scenario, baselinePatches },
    { patches, untilTimeOfDayMs: UNTIL, detail: 'tracked' },
  );
}

const runs = (() => {
  let cache: Record<'organic' | 'storm' | 'fix', ScenarioDayResult> | null = null;
  return () =>
    (cache ??= {
      organic: run([]),
      storm: run(scenario.baselinePatches),
      fix: run(scenario.baselinePatches, [
        { kind: 'set', atMs: scenario.entry.atMs, changes: scenario.namedFix!.changes },
      ]),
    });
})();

/** Fleet counts over [crash + fromMin, crash + toMin). */
function counts(r: ScenarioDayResult, fromMin: number, toMin: number): RequestCounts {
  return requestCountsIn(r, win(C + fromMin * MINUTE_MS, C + toMin * MINUTE_MS));
}

/** Requests served ÷ those served with no crash, over [crash + fromMin, crash + toMin). */
function goodput(r: ScenarioDayResult, fromMin: number, toMin: number): number {
  return counts(r, fromMin, toMin).finished / counts(runs().organic, fromMin, toMin).finished;
}

function ttftP99Ms(r: ScenarioDayResult, fromMin: number, toMin: number): number {
  const h = histogramIn(r, 'ttft', win(C + fromMin * MINUTE_MS, C + toMin * MINUTE_MS));
  return quantile(HISTOGRAM_SPECS.ttft, h, 0, 0.99);
}

describe('tab 6: retry storm', () => {
  it('opens paused shortly before the crash, and the storm shows within 45 s of play', () => {
    const day = dayOf(C);
    expect(day).toBeGreaterThanOrEqual(0);
    expect(day).toBeLessThanOrEqual(3); // Monday to Thursday (K2)
    expect(scenario.baselinePatches).toContainEqual({
      kind: 'event',
      atMs: C,
      event: { type: 'crash', replica: CRASHED_REPLICA },
    });
    expect(timeOfDayMs(scenario.entry.atMs)).toBeLessThanOrEqual(12 * HOUR_MS); // Server A (K30)
    expect(entryToMomentWallS(scenario)).toBeLessThanOrEqual(45); // §7.3, all tabs: 6 s
    // The storm's worst 2 minutes also play within 45 s: 8.4 s.
    const stormShownMs = C + 2 * MINUTE_MS - scenario.entry.atMs;
    expect(stormShownMs / scenario.entry.speed / 1000).toBeLessThanOrEqual(45);
  });

  it(
    'without the fix, immediate retries turn a 25% loss into a storm that wastes the GPUs',
    () => {
      const { organic, storm } = runs();
      // With no crash the busy fleet is calm: no retries to speak of, nobody abandons.
      const calm = counts(organic, -30, 15);
      expect(calm.offered / calm.organic).toBeLessThan(1.02);
      expect(calm.abandonedSessions).toBe(0);

      // The replacement is Ready ~2 min after the crash (10 s detection + 115 s cold start).
      const ready = readyAtOrAfter(storm, CRASHED_REPLICA, C);
      expect(ready).not.toBeNull();
      expect(ready! - C).toBeLessThanOrEqual(130_000);

      // Amplification over the 2 minutes after the crash: measured 2.59 (worst minute 3.9).
      const w2 = counts(storm, 0, 2);
      expect(w2.offered / w2.organic).toBeGreaterThanOrEqual(2);
      // Everything offered is admitted; there is no admission control.
      expect(w2.rejected).toBe(0);
      // Goodput: measured 35% of the no-crash run, well under the ~75% three replicas serve.
      expect(goodput(storm, 0, 2)).toBeLessThan(0.5);
      // TTFT p99 is pinned at the 10 s timeout: measured 10.0 s.
      expect(ttftP99Ms(storm, 0, 2)).toBeGreaterThanOrEqual(9_000);

      // Abandonment (K8): measured 348 conversations and 1,870 timeouts in 15 minutes.
      const w15 = counts(storm, 0, 15);
      expect(w15.abandonedSessions).toBeGreaterThanOrEqual(250);
      expect(w15.timedOut).toBeGreaterThanOrEqual(1_200);
      // Those analysts send no more turns: served stays ~10% low after recovery (measured 0.89).
      expect(goodput(storm, 5, 15)).toBeLessThan(0.95);
    },
    TIMEOUT,
  );

  it(
    'with backoff and admission control, rejects keep admitted load at what the survivors serve',
    () => {
      const { storm, fix } = runs();
      expect(scenario.namedFix!.changes).toEqual({
        retryPolicy: 'fullJitter',
        admissionLimitPerReplica: FIX_ADMISSION_LIMIT,
      });
      // The cap never bites before the crash: the fix is invisible on a healthy peak.
      expect(counts(fix, -2, 0).rejected).toBe(0);

      // Admitted ÷ first attempts over the 3 minutes after the crash: measured 0.99 (storm 2.30).
      const w3 = counts(fix, 0, 3);
      expect(w3.rejected).toBeGreaterThan(0);
      expect(w3.dispatched / w3.organic).toBeLessThanOrEqual(1.1);
      // Offered still exceeds first attempts (rejected requests retry): measured 1.75, storm 2.30.
      const s3 = counts(storm, 0, 3);
      expect(w3.offered / w3.organic).toBeLessThan(s3.offered / s3.organic);

      // Goodput holds near the survivors' capacity: measured 76% (storm 35%), and TTFT stays
      // under the timeout: measured p99 8.6 s, with no timeouts in 15 minutes (storm 1,870).
      expect(goodput(fix, 0, 2)).toBeGreaterThanOrEqual(0.65);
      expect(ttftP99Ms(fix, 0, 2)).toBeLessThan(10_000);
      const f15 = counts(fix, 0, 15);
      expect(f15.timedOut).toBeLessThanOrEqual(0.05 * counts(storm, 0, 15).timedOut);

      // Back to ≥ 90% within 15 minutes: measured 97% over [+5, +15) min, 93% over [0, +5).
      expect(goodput(fix, 5, 15)).toBeGreaterThanOrEqual(0.9);
      // Fewer abandoned conversations: measured 99 against 348.
      expect(f15.abandonedSessions).toBeLessThanOrEqual(
        0.5 * counts(storm, 0, 15).abandonedSessions,
      );
    },
    TIMEOUT,
  );
});
