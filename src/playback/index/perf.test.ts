// Query cost on a full Server B week of fixture chunks (8 replicas, five 07:00-17:00 shifts in
// 15-minute chunks), plus a Server B-scale hour of scope-'all' detail for canvas dots. Bounds are
// loose (about 10× the measured cost) so a busy machine doesn't flake; the table is the report.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultChunk } from '../../engine/results.ts';
import { HOUR_MS, MINUTE_MS, WEEK_MS, simMs, type DayIndex } from '../../engine/time.ts';
import { FIXTURE_TRACKED_ANALYST, makeFixtureChunks } from '../../fixtures/chunks.ts';
import type { ResultsStore } from '../types.ts';
import { createResultsStore } from './index.ts';
import { makeWorld, worldChunk } from './test-support.ts';

const REPLICAS = 8;
const COLUMNS = 1200;
const rows: { query: string; medianMs: number; maxMs: number }[] = [];

function time(query: string, fn: (i: number) => unknown, runs = 40): number {
  for (let i = 0; i < 5; i++) fn(i);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const medianMs = samples[Math.floor(runs / 2)]!;
  rows.push({ query, medianMs, maxMs: samples[runs - 1]! });
  return medianMs;
}

function once(query: string, fn: () => unknown): number {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  rows.push({ query, medianMs: ms, maxMs: ms });
  return ms;
}

describe('query cost on a Server B week', () => {
  const chunks: ResultChunk[] = [];
  let store: ResultsStore;
  const week = { fromMs: 0, toMs: WEEK_MS };
  const shift = { fromMs: simMs(2, 7), toMs: simMs(2, 17) };
  const hour = { fromMs: simMs(2, 10), toMs: simMs(2, 11) };
  const at = (i: number) => simMs((i % 5) as DayIndex, 7) + ((i * 7_919_000) % (10 * HOUR_MS));

  beforeAll(() => {
    const opts = { replicas: REPLICAS, crash: { replica: 5, atMs: simMs(2, 10, 30) } };
    for (let d = 0; d < 5; d++) {
      chunks.push(...makeFixtureChunks(opts, simMs(d as DayIndex, 7), simMs(d as DayIndex, 17)));
    }
    store = createResultsStore(REPLICAS);
    once(`addChunk × ${chunks.length} (whole week)`, () => {
      for (const c of chunks) store.addChunk(c);
    });
  }, 120_000);

  it('answers chart queries in O(buckets in the window)', () => {
    const q = [0.5, 0.99];
    expect(chunks).toHaveLength(200);
    expect(
      time('scalarSeries fleet, week, 1200 cols', () =>
        store.index.scalarSeries('kvUsedFrac', 0, week, COLUMNS),
      ),
    ).toBeLessThan(20);
    time('scalarSeries replica, week, 1200 cols', () =>
      store.index.scalarSeries('decodeTokens', 6, week, COLUMNS),
    );
    time('scalarSeries fleet, one shift, 1200 cols', () =>
      store.index.scalarSeries('ttftSumMs', 0, shift, COLUMNS),
    );
    time('scalarSeries fleet, one hour (360 pts)', () =>
      store.index.scalarSeries('running', 0, hour, COLUMNS),
    );
    expect(
      time('quantileSeries TTFT p50+p99, week, 1200 cols', () =>
        store.index.quantileSeries('ttft', 0, week, COLUMNS, q),
      ),
    ).toBeLessThan(40);
    time('quantileSeries TTFT p50+p99, one shift (600 pts)', () =>
      store.index.quantileSeries('ttft', 0, shift, COLUMNS, q),
    );
    time('quantileSeries E2E p99, one hour (60 pts)', () =>
      store.index.quantileSeries('e2e', 0, hour, COLUMNS, [0.99]),
    );
    // One full redraw of charts 1-3 for the whole week: TTFT mean and p99, E2E p99, KV %, preemptions,
    // and utilization for the fleet and all 8 replicas (worst-replica highlight).
    expect(
      time(
        'all three charts, week, fleet + 8 replicas',
        () => {
          for (let s = 0; s <= REPLICAS; s++) {
            store.index.scalarSeries('ttftSumMs', s, week, COLUMNS);
            store.index.scalarSeries('ttftCount', s, week, COLUMNS);
            store.index.quantileSeries('ttft', s, week, COLUMNS, [0.99]);
            store.index.quantileSeries('e2e', s, week, COLUMNS, [0.99]);
            store.index.scalarSeries('kvUsedFrac', s, week, COLUMNS);
            store.index.scalarSeries('preemptions', s, week, COLUMNS);
            store.index.scalarSeries('busyMs', s, week, COLUMNS);
            store.index.scalarSeries('flops', s, week, COLUMNS);
          }
        },
        10,
      ),
    ).toBeLessThan(300);
    expect(
      time('requestPoints, week (tracked records)', () => store.index.requestPoints(week)),
    ).toBeLessThan(20);
    time('requestPoints, one hour', () => store.index.requestPoints(hour));
  });

  it('answers per-frame queries in well under a frame', () => {
    const opts = { mode: 'live', detail: 'dots', trackedAnalyst: FIXTURE_TRACKED_ANALYST } as const;
    expect(
      time('sceneAt (aggregate, tracked analyst)', (i) => store.index.sceneAt(at(i), opts), 200),
    ).toBeLessThan(5);
    expect(time('statusAt', (i) => store.index.statusAt(at(i)), 200)).toBeLessThan(5);
  });

  it('costs the same late in the week as early (per-day indexes, not a chunk scan)', () => {
    const early = { fromMs: simMs(0, 9), toMs: simMs(0, 10) };
    const late = { fromMs: simMs(4, 16), toMs: simMs(4, 17) };
    const a = time(
      'scalarSeries, Monday 09:00 hour',
      () => store.index.scalarSeries('running', 0, early, COLUMNS),
      200,
    );
    const b = time(
      'scalarSeries, Friday 16:00 hour',
      () => store.index.scalarSeries('running', 0, late, COLUMNS),
      200,
    );
    expect(b).toBeLessThan(Math.max(0.5, 5 * a));
  });
});

describe('canvas dots at Server B scale', () => {
  let store: ResultsStore;
  const from = simMs(2, 10);
  const to = simMs(2, 11);

  beforeAll(() => {
    // 24 requests/s across 8 replicas for an hour: ~86k requests, ~400k transitions.
    const world = makeWorld({
      fromMs: from - 5 * MINUTE_MS,
      toMs: to,
      replicas: REPLICAS,
      perSecond: 24,
      terminalTransitions: false,
    });
    const chunks = [worldChunk(world, REPLICAS, from - 5 * MINUTE_MS, from)];
    for (let t = from; t < to; t += 15 * MINUTE_MS)
      chunks.push(worldChunk(world, REPLICAS, t, t + 15 * MINUTE_MS));
    store = createResultsStore(REPLICAS);
    const transitions = chunks.reduce((n, c) => n + c.transitions.count, 0);
    once(
      `addChunk × ${chunks.length} scope-all (${Math.round(transitions / 1000)}k transitions)`,
      () => {
        for (const c of chunks) store.addChunk(c);
      },
    );
  }, 120_000);

  it('reconstructs dots at any time in a few milliseconds', () => {
    const opts = { mode: 'live', detail: 'dots', trackedAnalyst: 3 } as const;
    const t = (i: number) => from + ((i * 7_919_111) % HOUR_MS);
    const dots = store.index.sceneAt(t(1), opts).replicas.reduce((n, r) => n + r.dots.length, 0);
    expect(dots).toBeGreaterThan(300);
    expect(
      time(
        `sceneAt with dots (~${dots} dots, random times)`,
        (i) => store.index.sceneAt(t(i), opts),
        200,
      ),
    ).toBeLessThan(10);
    // Playback at 1×: 60 fps steps of 16 ms.
    expect(
      time(
        'sceneAt with dots (60 fps playback)',
        (i) => store.index.sceneAt(from + 30 * MINUTE_MS + i * 16, opts),
        200,
      ),
    ).toBeLessThan(10);
    once('cut mid-chunk (truncate the dot stream)', () => store.cut(2, simMs(2, 10, 37), false));
    expect(store.index.sceneAt(simMs(2, 10, 36), opts).detail).toBe('dots');
  });
});

describe('report', () => {
  it('prints the timings', () => {
    const w = Math.max(...rows.map((r) => r.query.length));
    const lines = rows.map(
      (r) =>
        `${r.query.padEnd(w)}  ${r.medianMs.toFixed(3).padStart(9)} ms  (max ${r.maxMs.toFixed(3)} ms)`,
    );
    console.info(`\nResults index query timings (median of runs)\n${lines.join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(10);
  });
});
