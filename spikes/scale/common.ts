// S1 spike: shared helpers for the measurement scripts.

import { readFileSync } from 'node:fs';
import { parseCalibration, type Calibration } from '../../src/engine/calibration.ts';
import { SCALAR_METRIC_NAMES, type ResultChunk } from '../../src/engine/results.ts';
import { HOUR_MS } from '../../src/engine/time.ts';
import { defaultConfig, type SpikeConfig } from './workload.ts';

export function loadCalibration(): Calibration {
  const url = new URL('../../benchmarks/derived/calibration.json', import.meta.url);
  return parseCalibration(JSON.parse(readFileSync(url, 'utf8')));
}

/** --key=value flags. */
export function args(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? 'true';
  }
  return out;
}

export function configFromArgs(a: Record<string, string>): SpikeConfig {
  const o: Partial<SpikeConfig> = {};
  if (a.load) o.loadMultiplier = Number(a.load);
  if (a.spa) o.sessionsPerAnalystPerDay = Number(a.spa);
  if (a.apr) o.analystsPerReplica = Number(a.apr);
  if (a.turns) o.turnsPerSessionMean = Number(a.turns);
  if (a.bucket) o.bucketMs = Number(a.bucket);
  if (a.hist) o.histBucketMs = Number(a.hist);
  if (a.seed) o.seed = Number(a.seed);
  return defaultConfig(o);
}

export function nowMs(): number {
  return performance.now();
}

export function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) throw new Error('run with node --expose-gc');
  for (let i = 0; i < 4; i++) g();
}

export function mem(): { heapUsed: number; arrayBuffers: number; external: number; rss: number } {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, external: m.external, rss: m.rss };
}

export function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}

/** Exact nearest-rank quantile of a sorted array: the value at rank ceil(q n). */
export function exactQuantile(sorted: Float64Array | number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const i = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  return sorted[i]!;
}

export function hhmm(ms: number): string {
  const tod = ms % (24 * HOUR_MS);
  const h = Math.floor(tod / HOUR_MS);
  const m = Math.floor((tod % HOUR_MS) / 60_000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Fleet-series (index 0) mean of a scalar metric over the chunk's buckets. */
export function fleetScalarMean(chunk: ResultChunk, metric: (typeof SCALAR_METRIC_NAMES)[number]): number {
  const { count, series, data } = chunk.scalars;
  if (count === 0) return NaN;
  let s = 0;
  for (let b = 0; b < count; b++) s += data[metric][b * series]!;
  return s / count;
}

export function fleetScalarSum(chunk: ResultChunk, metric: (typeof SCALAR_METRIC_NAMES)[number]): number {
  const { count, series, data } = chunk.scalars;
  let s = 0;
  for (let b = 0; b < count; b++) s += data[metric][b * series]!;
  return s;
}

export function chunkBytes(chunk: ResultChunk): { scalars: number; histograms: number; requests: number; transitions: number } {
  const sum = (o: object) => {
    let n = 0;
    for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) n += v.byteLength;
    return n;
  };
  return {
    scalars: sum(chunk.scalars.data),
    histograms: sum(chunk.histograms.data),
    requests: sum(chunk.requests),
    transitions: sum(chunk.transitions),
  };
}
