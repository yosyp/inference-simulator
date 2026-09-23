import { describe, expect, it } from 'vitest';
import { HISTOGRAM_SPECS, addSparseCellInto, quantile } from '../engine/histogram.ts';
import {
  FLEET_SERIES,
  REPLICA_STATE,
  SCALAR_METRIC_NAMES,
  chunkTransferables,
} from '../engine/results.ts';
import { simMs } from '../engine/time.ts';
import { FIXTURE_HIST_BUCKET_MS, makeFixtureChunk, makeFixtureChunks } from './chunks.ts';
import { createFakeIndex } from './fake-index.ts';
import { fixtureScenarios } from './scenarios.ts';

const opts = { replicas: 8, crash: { replica: 3, atMs: simMs(2, 10, 30) } };

describe('fixture chunks', () => {
  const from = simMs(2, 10, 0);
  const chunk = makeFixtureChunk(opts, from, from + 60 * 60_000);

  it('matches the ResultChunk layout', () => {
    const { scalars, histograms } = chunk;
    expect(scalars.series).toBe(9);
    for (const m of SCALAR_METRIC_NAMES) {
      expect(scalars.data[m].length).toBe(scalars.count * scalars.series);
    }
    expect(histograms.count).toBe((60 * 60_000) / FIXTURE_HIST_BUCKET_MS);
    const ttft = histograms.data.ttft;
    expect(ttft.offsets.length).toBe(histograms.count * histograms.series + 1);
    expect(ttft.bins.length).toBe(ttft.counts.length);
    expect(ttft.offsets[ttft.offsets.length - 1]).toBe(ttft.counts.length);
  });

  it('has a plausible fleet TTFT p99', () => {
    const dense = new Uint32Array(HISTOGRAM_SPECS.ttft.bins);
    addSparseCellInto(dense, 0, chunk.histograms.data.ttft, FLEET_SERIES);
    const p99 = quantile(HISTOGRAM_SPECS.ttft, dense, 0, 0.99);
    expect(p99).toBeGreaterThan(50);
    expect(p99).toBeLessThan(60_000);
  });

  it('includes the crash and recovery as replica events', () => {
    const states = chunk.replicaEvents.map((e) => e.state);
    expect(states).toEqual([
      REPLICA_STATE.crashed,
      REPLICA_STATE.down,
      REPLICA_STATE.loadingWeights,
      REPLICA_STATE.initializingEngine,
      REPLICA_STATE.ready,
    ]);
  });

  it('lists transferable buffers', () => {
    expect(chunkTransferables(chunk).length).toBeGreaterThan(40);
  });

  it('tiles a range into consecutive chunks', () => {
    const chunks = makeFixtureChunks({ replicas: 1 }, simMs(0, 9), simMs(0, 10));
    expect(chunks.map((c) => c.fromMs)).toEqual([0, 1, 2, 3].map((i) => simMs(0, 9, i * 15)));
  });
});

describe('fake index', () => {
  const index = createFakeIndex(opts);

  it('returns at most one point per column', () => {
    const s = index.scalarSeries('kvUsedFrac', 1, { fromMs: 0, toMs: simMs(4, 23) }, 800);
    expect(s.t.length).toBeLessThanOrEqual(800);
  });

  it('shows the crashed replica loading, then ready', () => {
    expect(index.statusAt(simMs(2, 10, 31, 20)).replicas[3]!.state).toBe(
      REPLICA_STATE.loadingWeights,
    );
    expect(index.statusAt(simMs(2, 11, 0)).replicas[3]!.state).toBe(REPLICA_STATE.ready);
  });

  it('draws dots only in live dot mode', () => {
    const at = simMs(2, 10, 15);
    const dots = index.sceneAt(at, { mode: 'live', detail: 'dots', trackedAnalyst: null });
    const quiet = index.sceneAt(at, { mode: 'highSide', detail: 'dots', trackedAnalyst: null });
    expect(dots.replicas.some((r) => r.dots.length > 0)).toBe(true);
    expect(quiet.replicas.every((r) => r.dots.length === 0)).toBe(true);
  });

  it('produces a rollup row per replica per day', () => {
    expect(index.rollup().length).toBe(5 * 8);
  });
});

describe('fixture scenarios', () => {
  it('covers six tabs with matching replica counts', () => {
    const s = fixtureScenarios();
    expect(s.map((x) => x.tab)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const x of s) expect(x.sim.replicas).toBe(x.preset.replicas);
  });
});
