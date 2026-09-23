import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import { FLEET_SERIES, replicaSeries } from '../engine/results.ts';
import { simMs } from '../engine/time.ts';
import { makeFixtureChunks } from '../fixtures/chunks.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import { createResultsStore } from '../playback/index/index.ts';
import type { QuantileData, ResultsIndex, TimeWindow } from '../playback/types.ts';
import {
  buildChart3Panel,
  buildLoadPanel,
  buildOfferedPanel,
  buildUtilizationPanel,
} from './chart3-panels.ts';
import {
  MIN_LINE_POINTS,
  P99_MIN_COUNT,
  buildLatencyPanel,
  chooseLatencyResolution,
} from './latency-panel.ts';
import { buildMemoryPanel } from './memory-panel.ts';
import type { ChartLine, ChartPanel, PanelInput } from './panel-types.ts';
import { finiteMean } from './series.ts';
import { scaleCounts, withQueries } from './test-support.ts';

const WINDOW: TimeWindow = { fromMs: simMs(2, 7), toMs: simMs(2, 17) };
const PLAYHEAD = simMs(2, 12);

function input(index: ResultsIndex, columns = 600, visibleToMs = PLAYHEAD): PanelInput {
  return { index, window: WINDOW, columns, visibleToMs };
}

function line(panel: ChartPanel, id: string): ChartLine {
  const l = panel.lines.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id} in ${panel.lines.map((x) => x.id).join(', ')}`);
  return l;
}

function expectClipped(l: ChartLine, visibleToMs = PLAYHEAD) {
  expect(l.t.length).toBeGreaterThan(0);
  for (const t of l.t) expect(t + l.stepMs).toBeLessThanOrEqual(visibleToMs);
}

describe('latency panel (chart 1)', () => {
  const fake = createFakeIndex({ replicas: 1 });

  it('draws TTFT p99, TTFT mean, and E2E p99 up to the playhead', () => {
    const panel = buildLatencyPanel(input(scaleCounts(fake, 100)));
    expect(panel.mode).toBe('lines');
    expect(panel.lines.map((l) => l.id)).toEqual(['e2eP99', 'ttftMean', 'ttftP99']);
    expect(line(panel, 'ttftP99').style.widthPx).toBeGreaterThan(
      line(panel, 'e2eP99').style.widthPx,
    );
    for (const l of panel.lines) expectClipped(l);
    expect(panel.yScale).toBe('log');
  });

  it('takes percentiles from the index unchanged', () => {
    const idx = scaleCounts(fake, 100);
    const p99 = line(buildLatencyPanel(input(idx)), 'ttftP99');
    const q = idx.quantileSeries('ttft', FLEET_SERIES, WINDOW, 600, [0.99]);
    expect(Array.from(p99.v)).toEqual(Array.from(q.values[0]!.subarray(0, p99.v.length)));
    expect(p99.stepMs).toBe(q.stepMs);
  });

  it('computes the mean as ttftSumMs ÷ ttftCount per point, with gaps where nothing finished', () => {
    const idx = withQueries(scaleCounts(fake, 100), {
      scalarSeries: (metric, series, window, columns) => {
        const s = fake.scalarSeries(metric, series, window, columns);
        if (metric === 'ttftSumMs') return { ...s, v: s.v.map((_, i) => (i % 2 ? 0 : 300)) };
        if (metric === 'ttftCount') return { ...s, v: s.v.map((_, i) => (i % 2 ? 0 : 3)) };
        return s;
      },
    });
    const mean = line(buildLatencyPanel(input(idx)), 'ttftMean');
    expect(mean.v[0]).toBe(100);
    expect(mean.v[1]).toBeNaN();
    expect(mean.v[2]).toBe(100);
  });

  it('matches sum ÷ count from the fake index', () => {
    const mean = line(buildLatencyPanel(input(scaleCounts(fake, 100))), 'ttftMean');
    const sum = fake.scalarSeries('ttftSumMs', FLEET_SERIES, WINDOW, 600);
    const count = fake.scalarSeries('ttftCount', FLEET_SERIES, WINDOW, 600);
    const i = mean.v.length - 1;
    expect(mean.v[i]).toBeCloseTo(sum.v[i]! / count.v[i]!, 9);
  });

  it('highlights the worst replica by its p99 over the visible part of the window', () => {
    const base = scaleCounts(createFakeIndex({ replicas: 8 }), 100);
    // Replica 1 is worst before 11:00; replica 4 overtakes it once the window reaches past 11:00.
    const idx = withQueries(base, {
      quantileSeries: (metric, series, window, columns, qs): QuantileData => {
        const q = base.quantileSeries(metric, series, window, columns, qs);
        if (columns !== 1) return q;
        const late = window.toMs > simMs(2, 11);
        const v = series === 2 ? 500 : series === 5 ? (late ? 800 : 200) : 100;
        return { ...q, values: q.values.map((a) => a.map(() => v)) };
      },
    });
    const early = buildLatencyPanel(input(idx, 600, simMs(2, 10)));
    expect(early.worstReplica).toBe(1);
    expect(line(early, 'worstP99').endLabel).toBe('R2, worst');
    const later = buildLatencyPanel(input(idx, 600, simMs(2, 12)));
    expect(later.worstReplica).toBe(4);
    const worst = line(later, 'worstP99');
    const direct = base.quantileSeries('ttft', replicaSeries(4), WINDOW, 600, [0.99]);
    expect(Array.from(worst.v)).toEqual(Array.from(direct.values[0]!.subarray(0, worst.v.length)));
  });

  it('has no worst line with one replica, or before any time is visible', () => {
    expect(buildLatencyPanel(input(scaleCounts(fake, 100))).worstReplica).toBeNull();
    const eight = scaleCounts(createFakeIndex({ replicas: 8 }), 100);
    expect(buildLatencyPanel(input(eight, 600, WINDOW.fromMs)).worstReplica).toBeNull();
  });
});

describe('sparse buckets', () => {
  it('chooses full resolution, wider points, or individual requests from counts per point', () => {
    const n = 600;
    expect(chooseLatencyResolution(new Float64Array(n).fill(P99_MIN_COUNT), n)).toEqual({
      mode: 'lines',
      columns: n,
    });
    expect(chooseLatencyResolution(new Float64Array(n).fill(10), n)).toEqual({
      mode: 'lines',
      columns: 120,
    });
    // 1 per point: merging 50 gives 12 points, exactly the minimum.
    expect(chooseLatencyResolution(new Float64Array(n).fill(1), n)).toEqual({
      mode: 'lines',
      columns: MIN_LINE_POINTS,
    });
    expect(chooseLatencyResolution(new Float64Array(n).fill(0.5), n)).toEqual({ mode: 'requests' });
    // Empty and uncomputed points don't count toward the median.
    const mostlyEmpty = new Float64Array(n).fill(NaN);
    mostlyEmpty.fill(200, 0, 10);
    expect(chooseLatencyResolution(mostlyEmpty, n)).toEqual({ mode: 'lines', columns: n });
    expect(chooseLatencyResolution(new Float64Array(n), n)).toEqual({ mode: 'lines', columns: n });
  });

  it('plots individual requests when even wide points are too sparse (tab 1)', () => {
    const idx = scaleCounts(createFakeIndex({ replicas: 1 }), 0.001);
    const panel = buildLatencyPanel(input(idx, 300));
    expect(panel.mode).toBe('requests');
    expect(panel.lines).toEqual([]);
    expect(panel.note).toMatch(/each mark is one request/);
    const ttft = panel.points.find((p) => p.id === 'ttftRequests')!;
    expect(ttft.t.length).toBeGreaterThan(0);
    expect(ttft.t.length).toBeLessThanOrEqual(300);
    for (const t of ttft.t) expect(t).toBeLessThanOrEqual(PLAYHEAD);
  });

  it('widens p99 points when counts are low but enough for a line', () => {
    const idx = scaleCounts(createFakeIndex({ replicas: 1 }), 0.05);
    const panel = buildLatencyPanel(input(idx, 600));
    expect(panel.mode).toBe('lines');
    const p99 = line(panel, 'ttftP99');
    expect(p99.stepMs).toBeGreaterThan(idx.quantileSeries('ttft', 0, WINDOW, 600, [0.99]).stepMs);
    expect(panel.note).toMatch(/Wider p99/);
  });

  it('falls back to lines when no per-request records are available', () => {
    const base = scaleCounts(createFakeIndex({ replicas: 1 }), 0.001);
    const idx = withQueries(base, {
      requestPoints: (w) => {
        const p = base.requestPoints(w);
        return { ...p, t: new Float64Array(0) };
      },
    });
    expect(buildLatencyPanel(input(idx)).mode).toBe('lines');
  });
});

describe('memory panel (chart 2)', () => {
  it('draws fleet KV alone with one replica', () => {
    const panel = buildMemoryPanel(input(createFakeIndex({ replicas: 1 })));
    expect(panel.lines.map((l) => l.id)).toEqual(['kv']);
    expect(panel.worstReplica).toBeNull();
    expect(panel.yDomain).toEqual([0, 1]);
  });

  it('applies the fleet/worst rule at 8 replicas: fleet on top, highest in black, others muted', () => {
    const idx = createFakeIndex({ replicas: 8, crash: { replica: 3, atMs: simMs(2, 9) } });
    const panel = buildMemoryPanel(input(idx));
    const means = [...Array(8).keys()].map((r) => {
      const s = idx.scalarSeries('kvUsedFrac', replicaSeries(r), WINDOW, 600);
      const n = s.t.findIndex((t) => t + s.stepMs > PLAYHEAD);
      return finiteMean(s.v.subarray(0, n));
    });
    const expected = means.indexOf(Math.max(...means));
    expect(panel.worstReplica).toBe(expected);
    expect(panel.worstReplica).not.toBe(3);
    expect(panel.lines[panel.lines.length - 1]!.id).toBe('kv');
    expect(panel.lines.filter((l) => l.style.color.includes('series-muted'))).toHaveLength(7);
    expect(panel.lines.filter((l) => l.legend).map((l) => l.id)).toEqual(['worst', 'kv']);
    expect(line(panel, 'worst').endLabel).toBe(`R${expected + 1}, highest`);
  });

  it('marks preemptions from the fleet preemptions metric', () => {
    const idx = createFakeIndex({ replicas: 1 });
    const panel = buildMemoryPanel(input(idx, 600, simMs(2, 17)));
    const pre = idx.scalarSeries('preemptions', FLEET_SERIES, WINDOW, 600);
    expect(Array.from(panel.ticks!.v)).toEqual(
      Array.from(pre.v.subarray(0, panel.ticks!.v.length)),
    );
    expect(panel.ticks!.v.some((v) => v > 0)).toBe(true);
  });
});

describe('chart 3 panels', () => {
  it('computes utilization: busyMs ÷ step, and flops ÷ (calibration peak × step)', () => {
    const idx = createFakeIndex({ replicas: 1 });
    const panel = buildUtilizationPanel(input(idx), calibration);
    const busy = idx.scalarSeries('busyMs', FLEET_SERIES, WINDOW, 600);
    const flops = idx.scalarSeries('flops', FLEET_SERIES, WINDOW, 600);
    const i = 200;
    expect(line(panel, 'nvidiaSmi').v[i]).toBeCloseTo(busy.v[i]! / busy.stepMs, 12);
    const peak = calibration.gpu.peakDenseFp16Flops;
    expect(line(panel, 'compute').v[i]).toBeCloseTo(
      flops.v[i]! / (peak * (flops.stepMs / 1000)),
      12,
    );

    const doubled = { ...calibration, gpu: { ...calibration.gpu, peakDenseFp16Flops: 2 * peak } };
    const half = buildUtilizationPanel(input(idx), doubled);
    expect(line(half, 'compute').v[i]).toBeCloseTo(line(panel, 'compute').v[i]! / 2, 12);
    expect(line(half, 'nvidiaSmi').v[i]).toBe(line(panel, 'nvidiaSmi').v[i]);
  });

  it('shows per-replica load with a fleet average per Ready replica and the busiest highlighted', () => {
    // Replica 2 is down at the playhead: it crashed a minute earlier.
    const idx = createFakeIndex({ replicas: 8, crash: { replica: 2, atMs: simMs(2, 11, 59) } });
    const panel = buildLoadPanel(input(idx));
    expect(panel.worstReplica).not.toBeNull();
    const fleet = line(panel, 'fleet');
    const sum = idx.scalarSeries('outstanding', FLEET_SERIES, WINDOW, 600);
    const ready = idx.scalarSeries('readyReplicas', FLEET_SERIES, WINDOW, 600);
    const i = fleet.v.length - 1;
    expect(ready.v[i]).toBe(7);
    expect(fleet.v[i]).toBeCloseTo(sum.v[i]! / 7, 12);
    const engine = buildLoadPanel(input(idx), 'runningPlusWaiting');
    expect(engine.note).toMatch(/Running \+ waiting/);
  });

  it('shows offered vs. admitted per second, rejects, and amplification', () => {
    const idx = createFakeIndex({ replicas: 4 });
    const panel = buildOfferedPanel(input(idx));
    expect(panel.lines.map((l) => l.id)).toEqual([
      'rejected',
      'admitted',
      'offered',
      'amplification',
    ]);
    const offered = idx.scalarSeries('offered', FLEET_SERIES, WINDOW, 600);
    const i = 250;
    expect(line(panel, 'offered').v[i]).toBeCloseTo((offered.v[i]! * 1000) / offered.stepMs, 9);
    const amp = line(panel, 'amplification');
    expect(amp.hidden).toBe(true);
    expect(amp.v[i]).toBeCloseTo(1, 12);
    expect(panel.note).toBe('1.0× amplification in view');
  });

  it('dispatches on the kind', () => {
    const idx = createFakeIndex({ replicas: 2 });
    for (const kind of ['utilization', 'perReplicaLoad', 'offeredVsAdmitted'] as const) {
      expect(buildChart3Panel(kind, input(idx), { calibration }).kind).toBe(kind);
    }
  });
});

describe('against the real results index (U8)', () => {
  it("draws E9's merged-histogram p99 unchanged", () => {
    const opts = { replicas: 3 };
    const store = createResultsStore(opts.replicas);
    for (const c of makeFixtureChunks(opts, simMs(2, 9), simMs(2, 12))) store.addChunk(c);
    const window = { fromMs: simMs(2, 9), toMs: simMs(2, 12) };
    const panel = buildLatencyPanel({
      index: store.index,
      window,
      columns: 90,
      visibleToMs: simMs(2, 12),
    });
    expect(panel.mode).toBe('lines');
    const p99 = line(panel, 'ttftP99');
    const q = store.index.quantileSeries('ttft', FLEET_SERIES, window, 90, [0.99]);
    expect(p99.v.length).toBeGreaterThan(0);
    expect(Array.from(p99.v)).toEqual(Array.from(q.values[0]!.subarray(0, p99.v.length)));
    expect(p99.v.some(Number.isFinite)).toBe(true);
  });
});
