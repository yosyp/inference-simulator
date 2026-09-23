// Test harness for the metrics module: inputs, a runner with the shared and metrics modules around
// a stub, and helpers that join chunks back into whole-day arrays. Test-only; nothing imports it
// outside *.test.ts files.

import type { DayRunInput, SimConfig } from '../../api.ts';
import type { Calibration } from '../../calibration.ts';
import { createDayRunner } from '../../core/runner.ts';
import type { EngineModule } from '../../core/types.ts';
import {
  HISTOGRAM_METRICS,
  HISTOGRAM_SPECS,
  addSparseCellInto,
  type HistogramMetric,
} from '../../histogram.ts';
import {
  SCALAR_METRIC_NAMES,
  type ReplicaEvent,
  type RequestBlock,
  type ResultChunk,
  type ScalarMetric,
  type TransitionBlock,
} from '../../results.ts';
import { sharedModule } from '../../shared/module.ts';
import { DAY_MS, HOUR_MS, dayStartMs, type DayIndex } from '../../time.ts';
import { metricsModule } from '../module.ts';
import { quietScalar } from '../quiet.ts';

export const DAY: DayIndex = 1;
export const START = dayStartMs(DAY);
export const END = START + DAY_MS;

export interface HarnessOptions {
  replicas?: number;
  bucketMs?: number;
  histBucketMs?: number;
  detail?: 'all' | 'tracked';
  trackedAnalyst?: number | null;
  shift?: { startMs: number; endMs: number };
}

export function testConfig(o: HarnessOptions = {}): SimConfig {
  return {
    seed: 11,
    replicas: o.replicas ?? 2,
    analystsPerReplica: 10,
    shift: o.shift ?? { startMs: 7 * HOUR_MS, endMs: 19 * HOUR_MS },
    diurnal: { knots: [[0, 1]], dayMultipliers: [1, 1, 1, 1, 1] },
    sessionsPerAnalystPerDay: 1,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 2.5,
    virtualNodesPerReplica: 16,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: o.bucketMs ?? 10_000,
    histBucketMs: o.histBucketMs ?? 60_000,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 800,
      turnsPerSessionMean: 4,
      messageTokensMedian: 150,
      outputTokensMedian: 300,
      thinkTimeMedianMs: 90_000,
      timeoutToFirstTokenMs: 12_000,
      retryPolicy: 'none',
      retryBaseMs: 1_000,
      retryCapMs: 30_000,
      maxRetries: 0,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

// The core only fingerprints calibration, so a stand-in is enough.
const CALIBRATION = { schemaVersion: 1, status: 'provisional' } as unknown as Calibration;

export function testInput(o: HarnessOptions = {}): DayRunInput {
  return {
    config: testConfig(o),
    calibration: CALIBRATION,
    day: DAY,
    patches: [],
    trackedAnalyst: o.trackedAnalyst ?? null,
    detail: o.detail ?? 'tracked',
  };
}

/** shared, the stubs, then metrics (the E11 order with stubs in place of E6, E7, E5, E8). */
export function metricsRunner(stubs: readonly EngineModule[], assertEveryEvent = true) {
  return createDayRunner([sharedModule, ...stubs, metricsModule], { assertEveryEvent });
}

/** Whole-run data joined from consecutive chunks, checking that they tile without gaps. */
export interface Joined {
  scalarStartMs: number;
  buckets: number;
  scalars: Record<ScalarMetric, Float32Array>;
  histStartMs: number;
  histBuckets: number;
  /** Dense counts, (bucket × series + seriesIndex) × bins + bin, rebuilt from the sparse blocks. */
  hists: Record<HistogramMetric, Uint32Array>;
  requests: Record<Exclude<keyof RequestBlock, 'scope' | 'count'>, number[]>;
  transitions: Record<Exclude<keyof TransitionBlock, 'scope' | 'count'>, number[]>;
  replicaEvents: ReplicaEvent[];
  scopes: Set<string>;
}

function append(into: number[], from: ArrayLike<number>): void {
  for (let i = 0; i < from.length; i++) into.push(from[i]!);
}

/**
 * Joins chunks into whole-run arrays over their bucket spans (floor(fromMs) to floor(toMs) per
 * bucket width). Blocks may cover less than their chunk's span (quiet.ts); the buckets they omit
 * are filled as quiet (quietScalar; empty histograms), as the results store treats them.
 */
export function join(chunks: readonly ResultChunk[]): Joined {
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  const series = first.replicas + 1;
  const b = first.scalars.bucketMs;
  const hb = first.histograms.bucketMs;
  const scalarStartMs = Math.floor(first.fromMs / b) * b;
  const buckets = (Math.floor(last.toMs / b) * b - scalarStartMs) / b;
  const histStartMs = Math.floor(first.fromMs / hb) * hb;
  const histBuckets = (Math.floor(last.toMs / hb) * hb - histStartMs) / hb;
  const out: Joined = {
    scalarStartMs,
    buckets,
    scalars: Object.fromEntries(
      SCALAR_METRIC_NAMES.map((m) => {
        const a = new Float32Array(buckets * series);
        for (let k = 0; k < buckets; k++) {
          for (let r = 0; r < series; r++) a[k * series + r] = quietScalar(m, r, first.replicas);
        }
        return [m, a];
      }),
    ) as never,
    histStartMs,
    histBuckets,
    hists: Object.fromEntries(
      HISTOGRAM_METRICS.map((m) => [
        m,
        new Uint32Array(histBuckets * series * HISTOGRAM_SPECS[m].bins),
      ]),
    ) as never,
    requests: {} as never,
    transitions: {} as never,
    replicaEvents: [],
    scopes: new Set(),
  };
  let fromMs = first.fromMs;
  for (const c of chunks) {
    if (c.fromMs !== fromMs) throw new Error(`chunk starts at ${c.fromMs}, expected ${fromMs}`);
    fromMs = c.toMs;
    const sc = c.scalars;
    const spanFrom = Math.floor(c.fromMs / b) * b;
    const spanTo = Math.floor(c.toMs / b) * b;
    if (sc.count > 0 && (sc.startMs < spanFrom || sc.startMs + sc.count * b > spanTo)) {
      throw new Error('scalar block outside its chunk');
    }
    if (sc.series !== series) throw new Error('scalar series changed');
    const at = (sc.startMs - scalarStartMs) / b;
    for (const m of SCALAR_METRIC_NAMES) {
      if (sc.data[m].length !== sc.count * series) throw new Error(`${m} is mis-sized`);
      out.scalars[m].set(sc.data[m], at * series);
    }
    const h = c.histograms;
    const hFrom = Math.floor(c.fromMs / hb) * hb;
    const hTo = Math.floor(c.toMs / hb) * hb;
    if (h.count > 0 && (h.startMs < hFrom || h.startMs + h.count * hb > hTo)) {
      throw new Error('histogram block outside its chunk');
    }
    const hAt = (h.startMs - histStartMs) / hb;
    for (const m of HISTOGRAM_METRICS) {
      // Back to dense: cell k's bins at k × bins.
      const bins = HISTOGRAM_SPECS[m].bins;
      const cells = h.count * h.series;
      if (h.data[m].offsets.length !== cells + 1) throw new Error(`${m}: offsets mis-sized`);
      const base = hAt * series;
      for (let k = 0; k < cells; k++) {
        addSparseCellInto(out.hists[m], (base + k) * bins, h.data[m], k);
      }
    }
    for (const [block, into] of [
      [c.requests, out.requests],
      [c.transitions, out.transitions],
    ] as const) {
      out.scopes.add(block.scope);
      for (const [k, v] of Object.entries(block)) {
        if (!ArrayBuffer.isView(v)) continue;
        append(((into as Record<string, number[]>)[k] ??= []), v as unknown as ArrayLike<number>);
      }
    }
    out.replicaEvents.push(...c.replicaEvents);
  }
  return out;
}

/** Value of a scalar at a bucket and series in joined data. */
export function scalarAt(
  j: Joined,
  m: ScalarMetric,
  bucket: number,
  series: number,
  replicas: number,
) {
  return j.scalars[m][bucket * (replicas + 1) + series]!;
}

/** One series' histogram counts summed over all joined buckets. */
export function histTotal(
  j: Joined,
  m: HistogramMetric,
  series: number,
  replicas: number,
): Uint32Array {
  const bins = HISTOGRAM_SPECS[m].bins;
  const out = new Uint32Array(bins);
  const S = replicas + 1;
  for (let b = 0; b < j.histBuckets; b++) {
    const off = (b * S + series) * bins;
    for (let i = 0; i < bins; i++) out[i]! += j.hists[m][off + i]!;
  }
  return out;
}
