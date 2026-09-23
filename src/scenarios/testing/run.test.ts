import { describe, expect, it } from 'vitest';
import { FLEET_SERIES } from '../../engine/results.ts';
import { HOUR_MS, MINUTE_MS } from '../../engine/time.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import { ttftStatsInWindow } from './lessons.ts';
import { arrivedIn, sessionsMoved } from './records.ts';
import { runScenarioDay, setPatchAtDayStart } from './run.ts';
import { formatSummary, lessonSummary } from './summary.ts';
import { after, before } from './window.ts';

const routing = fixtureScenarios().find((s) => s.id === 'routing')!;
const UNTIL = 11 * HOUR_MS;

describe('runScenarioDay on the fixture routing tab', () => {
  const r = runScenarioDay(routing, { untilTimeOfDayMs: UNTIL });

  it('runs the lesson day to --until, with records and a working results index', () => {
    expect(r.day).toBe(2);
    expect(r.simMs).toBe(UNTIL);
    expect(r.rollup).toBeNull();
    expect(r.records.length).toBeGreaterThan(100);
    const w = before(r.momentMs, 15 * MINUTE_MS);
    const q = r.index.quantileSeries('ttft', FLEET_SERIES, w, 15, [0.99]);
    expect(q.values[0]!.some((v) => v > 0)).toBe(true);
    expect(r.index.requestPoints(w).t.length).toBeGreaterThan(0);
  });

  it('chunk-based and record-based TTFT agree on the mean', () => {
    const w = before(r.momentMs, 15 * MINUTE_MS);
    const fromChunks = ttftStatsInWindow(r, w);
    const inW = r.records.filter((x) => x.firstTokenMs >= w.fromMs && x.firstTokenMs < w.toMs);
    const mean = inW.reduce((s, x) => s + x.firstTokenMs - x.arriveMs, 0) / inW.length;
    expect(fromChunks.count).toBe(inW.length);
    expect(fromChunks.meanMs).toBeCloseTo(mean, 0);
  });

  it('a day-start patch changes routing: affinity moves no sessions', () => {
    const rr = sessionsMoved(r.records, r.momentMs, arrivedIn(after(r.momentMs, HOUR_MS)));
    expect(rr.fraction).toBeGreaterThan(0.3);
    const aff = runScenarioDay(routing, {
      untilTimeOfDayMs: UNTIL,
      patches: [setPatchAtDayStart(2, { routingPolicy: 'sessionAffinity' })],
    });
    expect(sessionsMoved(aff.records, aff.momentMs).fraction).toBe(0);
  });

  it('summarizes around the lesson moment', () => {
    const text = formatSummary(lessonSummary(r));
    expect(text).toContain('Tab 4 routing');
    expect(text).toMatch(/TTFT p99 ms\s+\d/);
    expect(text).toContain('replica 2');
  });
});
