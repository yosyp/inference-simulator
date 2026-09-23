// Tab 3 lesson assertions (00-build §7.3), on the provisional calibration. Measured values at the
// time of writing are in brackets; thresholds leave margin for X4's retune.
//
// Refinements to §7.3's proposal, from the runs:
// - KV: the 1-minute mean sits at 90–96% once the pool is full, not above 95%. The waiting head is
//   admitted only when its whole uncached prompt fits (02 §7), and at the plateau that prompt is a
//   5–15k-token history, so a gap of that size stays free. The bar is 90% for 10 minutes, with the
//   pool's peak at 100%.
// - Recompute: preemption recompute is small [~2% of prefill tokens], because a preempted request
//   goes to the front of the queue and its freed blocks are the last to be evicted. Most prefill
//   at the plateau is returning turns re-prefilling history they had computed on the previous
//   turn, evicted from the cache [~90%]. Both are "prefill it already paid for"; the test asserts
//   preemption recompute happens and the history share is large.
// - Throughput: requests served per minute across the plateau stay within 15% of the 10 minutes
//   before it [+6%]; 5-minute counts alone vary by about ±10%.
// - The TTFT mean rises too once a queue forms [~90 s at the plateau], so the copy doesn't claim
//   the mean hides the problem there. p99 leads it by a few minutes on the way up.

import { beforeAll, describe, expect, it } from 'vitest';
import { calibration } from '../../data/calibration.ts';
import { MINUTE_MS, dayOf, timeOfDayMs } from '../../engine/time.ts';
import { entryToMomentWallS, runScenarioDay } from '../testing/index.ts';
import { scenario } from './index.ts';
import { KV_FULL, SEARCH_MS, lessonNumbers, type Tab3Lesson } from './lesson.ts';

let n: Tab3Lesson;

beforeAll(() => {
  const r = runScenarioDay(scenario, {
    untilTimeOfDayMs: timeOfDayMs(scenario.lessonMoment.atMs) + SEARCH_MS,
  });
  n = lessonNumbers(r);
});

describe('tab 3 · KV exhaustion', () => {
  it('opens shortly before the moment, and the pool is full within 45 s of Play', () => {
    const { entry, lessonMoment } = scenario;
    expect(dayOf(lessonMoment.atMs)).toBeLessThanOrEqual(3); // Monday to Thursday (K2)
    expect(dayOf(entry.atMs)).toBe(dayOf(lessonMoment.atMs));
    expect(entry.atMs).toBeLessThan(lessonMoment.atMs);
    expect(entryToMomentWallS(scenario)).toBeLessThanOrEqual(45); // [6 s]
    // The visible lesson (KV past 90%) comes later than the moment itself. [35 s]
    expect(n.plateau).not.toBeNull();
    expect((n.plateau!.fromMs - entry.atMs) / entry.speed / 1000).toBeLessThanOrEqual(45);
  });

  it('fills the KV pool, then preempts and re-prefills work it already did', () => {
    expect(n.plateauMs).toBeGreaterThanOrEqual(10 * MINUTE_MS); // [27 min at >= 90%]
    expect(KV_FULL).toBeGreaterThanOrEqual(0.9);
    expect(n.kvMaxInPlateau).toBeGreaterThanOrEqual(0.99); // [100%]
    expect(n.preemptions).toBeGreaterThanOrEqual(10); // [58]
    expect(n.preemptRecomputeShare).toBeGreaterThan(0); // [1.6%]
    expect(n.historyRecomputeShare).toBeGreaterThanOrEqual(0.5); // [91%]
  });

  it('reads busy on nvidia-smi while compute stays under half of what it can reach', () => {
    expect(n.nvidiaSmi).toBeGreaterThanOrEqual(0.9); // [100%]
    // Compute utilization can't exceed η_c, so the bar is η_c / 2 (§7.3, E3). [16% vs 25%]
    expect(n.compute).toBeLessThanOrEqual(calibration.costModel.computeEfficiency / 2);
  });

  it('keeps requests served level while TTFT p99 climbs', () => {
    expect(n.ttftP99PlateauMs).toBeGreaterThanOrEqual(3 * n.ttftP99BeforeMs); // [140 s vs 0.14 s]
    const change = n.servedPerMinPlateau / n.servedPerMinLeadIn - 1;
    expect(Math.abs(change)).toBeLessThanOrEqual(0.15); // [15.9 vs 15.0 per minute: +6%]
  });
});
