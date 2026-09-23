// The metrics slice stays small between advances, whatever the load (checkpoints clone it).
// The benchmark at the bottom is skipped unless E9_BENCH is set:
//   E9_BENCH=1 pnpm vitest run --project node src/engine/metrics/size.test.ts --reporter=verbose

import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { createDayRunner } from '../core/runner.ts';
import type { EngineModule } from '../core/types.ts';
import { sharedModule } from '../shared/module.ts';
import { HOUR_MS, MINUTE_MS } from '../time.ts';
import { END, START, testInput } from './fixtures/harness.ts';
import { synthStub, type SynthOptions } from './fixtures/synth-stub.ts';
import { metricsModule } from './index.ts';

const CHUNK_MS = 5 * MINUTE_MS; // G1: 5-minute chunks
const REPLICAS = 8;

function synth(gapMs: number): SynthOptions {
  return {
    gapMs,
    fromMs: 6 * HOUR_MS + 30 * MINUTE_MS,
    toMs: 18 * HOUR_MS,
    analysts: 3_200,
    crash: { replica: 5, atMs: 10 * HOUR_MS + 17 * MINUTE_MS },
  };
}

interface DayStats {
  requests: number;
  chunks: number;
  peakSliceBytes: number;
  sliceBytesAt: number[];
  wallMs: number;
}

function runDay(gapMs: number, detail: 'all' | 'tracked', withMetrics = true): DayStats {
  const modules: EngineModule[] = [sharedModule, synthStub(synth(gapMs))];
  if (withMetrics) modules.push(metricsModule);
  const run = createDayRunner(modules).createDayRun(
    testInput({ replicas: REPLICAS, detail, trackedAnalyst: 17 }),
  );
  const stats: DayStats = {
    requests: 0,
    chunks: 0,
    peakSliceBytes: 0,
    sliceBytesAt: [],
    wallMs: 0,
  };
  const t0 = process.hrtime.bigint();
  for (let t = START + CHUNK_MS; t <= END; t += CHUNK_MS) {
    run.advance(t);
    stats.chunks++;
    if (!withMetrics) continue;
    const bytes = serialize(run.state.metrics).byteLength;
    stats.peakSliceBytes = Math.max(stats.peakSliceBytes, bytes);
    if ((t - START) % HOUR_MS === 0) stats.sliceBytesAt.push(bytes);
  }
  stats.wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  stats.requests = run.state.shared.requests.nextId;
  if (withMetrics) run.assertInvariants();
  return stats;
}

describe('slice size', () => {
  it('stays bounded over a long day and does not grow with load', () => {
    const light = runDay(1_600, 'all');
    const heavy = runDay(400, 'all');
    expect(heavy.requests).toBeGreaterThan(90_000);
    expect(heavy.requests).toBeGreaterThan(3.5 * light.requests);
    // Open accumulators, previous meter values, and per-day totals only: about 20 KB for 8 replicas.
    expect(heavy.peakSliceBytes).toBeLessThan(32 * 1024);
    // Same size at 4× the load, and through the day (a few bytes move with V8's number encoding).
    expect(Math.abs(heavy.peakSliceBytes - light.peakSliceBytes)).toBeLessThan(64);
    expect(Math.max(...heavy.sliceBytesAt) - Math.min(...heavy.sliceBytesAt)).toBeLessThan(64);
  }, 60_000);
});

describe.skipIf(!process.env.E9_BENCH)('metrics benchmark', () => {
  it('reports slice size, clone cost, and the module overhead at Server B scale', () => {
    // About 1.2–1.5M requests per Server B week (S1), so about 300k per day: a 140 ms mean gap.
    for (const detail of ['tracked', 'all'] as const) {
      runDay(140, detail); // warm up
      const withM = runDay(140, detail);
      const without = runDay(140, detail, false);
      const perReq = ((withM.wallMs - without.wallMs) / withM.requests) * 1e3;
      console.log(
        `detail ${detail}: ${withM.requests} requests, ${withM.chunks} chunks; ` +
          `day ${withM.wallMs.toFixed(0)} ms with metrics, ${without.wallMs.toFixed(0)} ms without ` +
          `(${perReq.toFixed(2)} µs per request); peak slice ${withM.peakSliceBytes} B`,
      );
    }
    // Clone cost of the slice mid-bucket at the peak.
    const run = createDayRunner([sharedModule, synthStub(synth(140)), metricsModule]).createDayRun(
      testInput({ replicas: REPLICAS, detail: 'all' }),
    );
    run.advance(START + 10 * HOUR_MS + 30 * MINUTE_MS + 4_321);
    const slice = run.state.metrics;
    for (let i = 0; i < 200; i++) structuredClone(slice);
    const n = 2_000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) structuredClone(slice);
    const cloneUs = Number(process.hrtime.bigint() - t0) / 1e3 / n;
    console.log(
      `metrics slice mid-bucket at 10:30: ${serialize(slice).byteLength} B serialized, ` +
        `structuredClone ${cloneUs.toFixed(1)} µs`,
    );
  }, 600_000);
});
