import { describe, expect, it } from 'vitest';
import {
  HISTOGRAM_SPECS,
  quantile,
  totalCount,
  type HistogramMetric,
  addSparseCellInto,
} from '../../engine/histogram.ts';
import {
  FLEET_SERIES,
  allocHistogramBlock,
  allocScalarBlock,
  SCALAR_METRICS,
  SCALAR_METRIC_NAMES,
  replicaSeries,
  type ResultChunk,
  type ScalarMetric,
} from '../../engine/results.ts';
import { DAY_MS, simMs } from '../../engine/time.ts';
import {
  FIXTURE_BUCKET_MS,
  FIXTURE_HIST_BUCKET_MS,
  makeFixtureChunks,
} from '../../fixtures/chunks.ts';
import type { TimeWindow } from '../types.ts';
import { createResultsStore } from './index.ts';
import { chooseGrid } from './series.ts';

const opts = { replicas: 3, crash: { replica: 1, atMs: simMs(1, 10, 30) } };
// Two shifts' mornings, in 15-minute chunks, delivered out of order across days.
const chunks: ResultChunk[] = [
  ...makeFixtureChunks(opts, simMs(1, 9), simMs(1, 12)),
  ...makeFixtureChunks(opts, simMs(0, 9), simMs(0, 11), 20 * 60_000),
];

function store() {
  const s = createResultsStore(opts.replicas);
  for (const c of chunks) s.addChunk(c);
  return s;
}

/** Direct aggregation over every chunk's buckets that start in [t, t + step). */
function directScalar(metric: ScalarMetric, series: number, t: number, step: number): number {
  const agg = SCALAR_METRICS[metric];
  const xs: number[] = [];
  for (const c of chunks) {
    const b = c.scalars;
    for (let i = 0; i < b.count; i++) {
      const start = b.startMs + i * b.bucketMs;
      if (start >= t && start < t + step) xs.push(b.data[metric][i * b.series + series]!);
    }
  }
  if (xs.length === 0) return NaN;
  if (agg === 'max') return Math.max(...xs);
  const sum = xs.reduce((a, x) => a + x, 0);
  return agg === 'mean' ? sum / xs.length : sum;
}

function directHistogram(metric: HistogramMetric, series: number, t: number, step: number) {
  const bins = HISTOGRAM_SPECS[metric].bins;
  const merged = new Uint32Array(bins);
  let buckets = 0;
  for (const c of chunks) {
    const h = c.histograms;
    for (let i = 0; i < h.count; i++) {
      const start = h.startMs + i * h.bucketMs;
      if (start < t || start >= t + step) continue;
      buckets++;
      addSparseCellInto(merged, 0, h.data[metric], i * h.series + series);
    }
  }
  return { merged, buckets };
}

const windows: [string, TimeWindow, number][] = [
  ['one bucket per column', { fromMs: simMs(1, 9, 3), toMs: simMs(1, 9, 50) }, 1000],
  ['across chunk boundaries', { fromMs: simMs(1, 9, 7, 30), toMs: simMs(1, 11, 41) }, 37],
  ['across two days and a night', { fromMs: simMs(0, 10), toMs: simMs(1, 10) }, 200],
  ['a coarse window', { fromMs: 0, toMs: 2 * DAY_MS }, 7],
];

describe('scalarSeries', () => {
  const s = store();

  for (const [name, window, columns] of windows) {
    it(`matches a direct computation for every metric and series: ${name}`, () => {
      for (const metric of SCALAR_METRIC_NAMES) {
        for (const series of [FLEET_SERIES, replicaSeries(0), replicaSeries(2)]) {
          const got = s.index.scalarSeries(metric, series, window, columns);
          for (let i = 0; i < got.t.length; i++) {
            const want = directScalar(metric, series, got.t[i]!, got.stepMs);
            if (Number.isNaN(want)) expect(got.v[i], `${metric} ${i}`).toBeNaN();
            else expect(got.v[i], `${metric} ${i}`).toBeCloseTo(want, 6);
          }
        }
      }
    });
  }

  it('covers the window with at most `columns` points on a step grid', () => {
    for (const [, window, columns] of windows) {
      const got = s.index.scalarSeries('running', 0, window, columns);
      expect(got.t.length).toBeLessThanOrEqual(columns);
      expect(got.stepMs % FIXTURE_BUCKET_MS).toBe(0);
      expect(got.t[0]).toBeLessThanOrEqual(window.fromMs);
      expect(got.t[got.t.length - 1]! + got.stepMs).toBeGreaterThanOrEqual(window.toMs);
      for (const t of got.t) expect(t % got.stepMs).toBe(0);
    }
  });

  it('checks each aggregation kind on a hand-picked point', () => {
    // 09:00-09:01 on Tuesday: six 10 s buckets of replica 0.
    const w = { fromMs: simMs(1, 9), toMs: simMs(1, 9, 1) };
    const first = chunks.find((c) => c.fromMs === simMs(1, 9))!.scalars;
    const col = (m: ScalarMetric) =>
      Array.from({ length: 6 }, (_, i) => first.data[m][i * first.series + 1]!);
    const sum = s.index.scalarSeries('decodeTokens', 1, w, 1).v[0]!;
    const mean = s.index.scalarSeries('kvUsedFrac', 1, w, 1).v[0]!;
    const max = s.index.scalarSeries('kvUsedFracMax', 1, w, 1).v[0]!;
    expect(sum).toBeCloseTo(
      col('decodeTokens').reduce((a, x) => a + x),
      3,
    );
    expect(mean).toBeCloseTo(col('kvUsedFrac').reduce((a, x) => a + x) / 6, 9);
    expect(max).toBe(Math.max(...col('kvUsedFracMax')));
  });

  it('returns NaN for uncomputed time and unknown series', () => {
    const night = s.index.scalarSeries(
      'running',
      0,
      { fromMs: simMs(0, 20), toMs: simMs(0, 22) },
      10,
    );
    expect([...night.v].every(Number.isNaN)).toBe(true);
    const bad = s.index.scalarSeries(
      'running',
      99,
      { fromMs: simMs(1, 9), toMs: simMs(1, 10) },
      10,
    );
    expect([...bad.v].every(Number.isNaN)).toBe(true);
    const empty = createResultsStore(2).index.scalarSeries('running', 0, windows[0]![1], 10);
    expect(empty.t.length).toBeLessThanOrEqual(10);
    expect([...empty.v].every(Number.isNaN)).toBe(true);
  });
});

describe('quiet buckets the engine omits (quiet.ts)', () => {
  it('reads a delivered chunk’s missing buckets as quiet, not uncomputed, until a cut', () => {
    const s = createResultsStore(opts.replicas);
    const [c] = makeFixtureChunks(opts, simMs(0, 20), simMs(0, 22), 2 * 60 * 60_000);
    const series = opts.replicas + 1;
    s.addChunk({
      ...c!,
      scalars: allocScalarBlock(c!.fromMs, FIXTURE_BUCKET_MS, 0, series),
      histograms: allocHistogramBlock(c!.fromMs, FIXTURE_HIST_BUCKET_MS, 0, series),
    });
    const night = { fromMs: simMs(0, 20), toMs: simMs(0, 22) };
    const running = s.index.scalarSeries('running', FLEET_SERIES, night, 10);
    expect([...running.v]).toEqual(new Array(running.v.length).fill(0));
    const ready = s.index.scalarSeries('readyReplicas', FLEET_SERIES, night, 10);
    expect([...ready.v]).toEqual(new Array(ready.v.length).fill(opts.replicas));
    const q = s.index.quantileSeries('ttft', FLEET_SERIES, night, 10, [0.5]);
    expect([...q.counts]).toEqual(new Array(q.counts.length).fill(0));
    s.cut(0, simMs(0, 21), false);
    const after = s.index.scalarSeries('running', FLEET_SERIES, night, 2);
    expect(after.v[0]).toBe(0);
    expect(after.v[1]).toBeNaN();
  });
});

describe('quantileSeries', () => {
  const s = store();
  const qs = [0.5, 0.9, 0.99];

  for (const [name, window, columns] of windows) {
    it(`matches quantiles of a direct histogram merge: ${name}`, () => {
      for (const metric of ['ttft', 'tpot', 'e2e'] as const) {
        for (const series of [FLEET_SERIES, replicaSeries(1)]) {
          const got = s.index.quantileSeries(metric, series, window, columns, qs);
          expect(got.stepMs % FIXTURE_HIST_BUCKET_MS).toBe(0);
          expect(got.t.length).toBeLessThanOrEqual(columns);
          for (let i = 0; i < got.t.length; i++) {
            const { merged, buckets } = directHistogram(metric, series, got.t[i]!, got.stepMs);
            if (buckets === 0) {
              expect(got.counts[i]).toBeNaN();
              for (const v of got.values) expect(v[i]).toBeNaN();
              continue;
            }
            expect(got.counts[i]).toBe(totalCount(merged, 0, merged.length));
            qs.forEach((q, k) => {
              const want = quantile(HISTOGRAM_SPECS[metric], merged, 0, q);
              if (Number.isNaN(want)) expect(got.values[k]![i]).toBeNaN();
              else expect(got.values[k]![i]).toBe(want);
            });
          }
        }
      }
    });
  }

  it('reports zero counts for a computed but empty bucket', () => {
    // Replica 1 is down after the crash, so its histogram buckets are empty.
    const got = s.index.quantileSeries(
      'ttft',
      replicaSeries(1),
      { fromMs: simMs(1, 10, 31), toMs: simMs(1, 10, 32) },
      1,
      [0.5],
    );
    expect(got.counts[0]).toBe(0);
    expect(got.values[0]![0]).toBeNaN();
  });
});

describe('chooseGrid', () => {
  it('keeps at most `columns` points for any window', () => {
    for (let i = 0; i < 500; i++) {
      const from = Math.floor(Math.abs(Math.sin(i) * 5 * DAY_MS));
      const span = 1 + Math.floor(Math.abs(Math.cos(i * 7)) * DAY_MS);
      const cols = 1 + (i % 50);
      const g = chooseGrid({ fromMs: from, toMs: from + span }, cols, 10_000);
      expect(g.n).toBeLessThanOrEqual(cols);
      expect(g.t0).toBeLessThanOrEqual(from);
      expect(g.t0 + g.n * g.stepMs).toBeGreaterThanOrEqual(from + span);
      expect(g.stepMs % 10_000).toBe(0);
    }
  });
});
