// "At most one point per pixel column" (05 §6, 04 §3): no path has more vertices than columns.

import { scaleLinear, scaleLog } from 'd3-scale';
import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import { simMs } from '../engine/time.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import type { TimeWindow } from '../playback/types.ts';
import { buildLivePanels } from './live-panels.ts';
import type { ChartPanel } from './panel-types.ts';
import { linePath, pathVertexCount } from './paths.ts';
import { decimatePerColumn } from './series.ts';
import { scaleCounts } from './test-support.ts';

const WINDOWS: TimeWindow[] = [
  { fromMs: simMs(2, 7), toMs: simMs(2, 17) },
  { fromMs: simMs(2, 10), toMs: simMs(2, 11) },
  { fromMs: simMs(3, 9, 7), toMs: simMs(3, 9, 22) },
];

function pathsOf(panel: ChartPanel, window: TimeWindow, columns: number): string[] {
  const x = scaleLinear().domain([window.fromMs, window.toMs]).range([0, columns]);
  const y =
    panel.yScale === 'log'
      ? scaleLog().domain(panel.yDomain).range([100, 0]).clamp(true)
      : scaleLinear().domain(panel.yDomain).range([100, 0]);
  return panel.lines.map((l) => linePath(l.t, l.v, l.stepMs, x, y));
}

describe('decimation', () => {
  for (const replicas of [1, 8]) {
    for (const columns of [37, 240, 913]) {
      it(`keeps every path within ${columns} columns (${replicas} replica${replicas > 1 ? 's' : ''})`, () => {
        for (const counts of [100, 0.001]) {
          const index = scaleCounts(createFakeIndex({ replicas }), counts);
          for (const window of WINDOWS) {
            for (const chart3 of ['utilization', 'perReplicaLoad', 'offeredVsAdmitted'] as const) {
              const panels = buildLivePanels({
                index,
                version: 1,
                fromMs: window.fromMs,
                toMs: window.toMs,
                columns,
                visibleToMs: window.toMs,
                chart3,
                calibration,
                loadMetric: 'outstanding',
              });
              for (const panel of panels) {
                for (const l of panel.lines) expect(l.t.length).toBeLessThanOrEqual(columns);
                for (const p of panel.points) expect(p.t.length).toBeLessThanOrEqual(columns);
                for (const d of pathsOf(panel, window, columns)) {
                  expect(pathVertexCount(d)).toBeLessThanOrEqual(columns);
                }
              }
            }
          }
        }
      });
    }
  }

  it('merges points that share a pixel column, keeping the highest', () => {
    const n = 10_000;
    const t = Float64Array.from({ length: n }, (_, i) => i);
    const v = Float64Array.from({ length: n }, (_, i) => (i === 5_555 ? 1_000 : i % 7));
    const x = scaleLinear().domain([0, n]).range([0, 100]);
    const y = scaleLinear().domain([0, 1_000]).range([100, 0]);
    const d = linePath(t, v, 1, x, y);
    expect(pathVertexCount(d)).toBeLessThanOrEqual(100);
    // The spike survives decimation: some vertex sits at the top of the plot.
    expect(d).toMatch(/[ML][\d.]+,0(?![\d.])/);
  });

  it('breaks lines at gaps', () => {
    const x = scaleLinear().domain([0, 4]).range([0, 400]);
    const y = scaleLinear().domain([0, 10]).range([100, 0]);
    const d = linePath([0, 1, 2, 3], [1, 2, NaN, 4], 1, x, y);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('keeps one request per column, the slowest', () => {
    const t = [0, 0.2, 0.4, 1.5, 2.9];
    const v = [5, 50, 7, 3, NaN];
    const out = decimatePerColumn(t, v, (ms) => ms);
    expect(Array.from(out.v)).toEqual([50, 3]);
    expect(Array.from(out.t)).toEqual([0.2, 1.5]);
  });
});
