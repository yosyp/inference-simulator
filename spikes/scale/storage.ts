// S1 spike: bytes per week of scalar and histogram blocks for candidate bucket widths and storage
// layouts, and percentile error of candidate histogram specs against exact quantiles of the
// simulated latencies. pnpm exec tsx spikes/scale/storage.ts [--spa=16]
// Samples are cached in the scratch dir given by --cache (default: none, re-simulate).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binIndex, HISTOGRAM_SPECS, quantile, type HistogramSpec } from '../../src/engine/histogram.ts';
import { SCALAR_METRIC_NAMES } from '../../src/engine/results.ts';
import { DAY_MS, HOUR_MS, WEEK_DAYS } from '../../src/engine/time.ts';
import { args, configFromArgs, exactQuantile, loadCalibration, mb } from './common.ts';
import { createDay } from './engine.ts';

const a = args();
const cfg = configFromArgs(a);
const cal = loadCalibration();
const R = cfg.replicas;
const SERIES = R + 1;
const COLS = 7; // day, replica, firstTokenMs, ttft, endMs, tpot (NaN if none), e2e

function simulate(): Float64Array {
  const rows: number[] = [];
  for (let day = 0; day < WEEK_DAYS; day++) {
    const run = createDay(cfg, cal, day, { detail: 'all', trackedAnalyst: 0, prefixCache: false, recordMetrics: false });
    for (let t = day * DAY_MS; t < (day + 1) * DAY_MS; t += 15 * 60_000) {
      const r = run.advance(t + 15 * 60_000).requests;
      for (let i = 0; i < r.count; i++) {
        const ft = r.firstTokenMs[i]!;
        if (ft !== ft) continue;
        const end = r.endMs[i]!;
        const out = r.outputTokens[i]!;
        const fin = r.outcome[i] === 5;
        rows.push(day, r.replica[i]!, ft, ft - r.arriveMs[i]!, fin ? end : NaN, fin && out > 1 ? (end - ft) / (out - 1) : NaN, fin ? end - r.arriveMs[i]! : NaN);
      }
    }
    console.error(`simulated day ${day}`);
  }
  return Float64Array.from(rows);
}

let samples: Float64Array;
const cache = a.cache;
if (cache && existsSync(cache)) samples = new Float64Array(readFileSync(cache).buffer.slice(0));
else {
  samples = simulate();
  if (cache) writeFileSync(cache, Buffer.from(samples.buffer));
}
const n = samples.length / COLS;
console.log(`samples (requests with a first token, week): ${n}`);

// ---------- scalars ----------
const shiftHours = 11.5; // 06:30-18:00 carries all activity at this load
console.log('\n## Scalar blocks per week (dense Float32, 34 metrics x 9 series)');
for (const bucketMs of [10_000, 30_000]) {
  const perBucket = SCALAR_METRIC_NAMES.length * SERIES * 4;
  const fullDay = (DAY_MS / bucketMs) * perBucket * WEEK_DAYS;
  const shift = ((shiftHours * HOUR_MS) / bucketMs) * perBucket * WEEK_DAYS;
  console.log(`bucketMs ${bucketMs / 1000}s: whole day ${mb(fullDay)} MB/week; shift-only ${mb(shift)} MB/week`);
}

// ---------- histograms ----------
type Metric = 'ttft' | 'tpot' | 'e2e';
const VAL: Record<Metric, number> = { ttft: 3, tpot: 5, e2e: 6 };
const TIME: Record<Metric, number> = { ttft: 2, tpot: 4, e2e: 4 };

function variants(m: Metric): { name: string; spec: HistogramSpec }[] {
  const base = HISTOGRAM_SPECS[m];
  return [1, 1.5, 2, 3, 4].map((k) => {
    const spec = { minMs: base.minMs, maxMs: base.maxMs, bins: Math.round(base.bins * k) };
    const r = Math.pow(spec.maxMs / spec.minMs, 1 / spec.bins);
    return { name: `${spec.bins} bins (r=${r.toFixed(3)})`, spec };
  });
}

interface Layout { rows: number; shiftRows: number; nnz: number; shiftNnz: number; maxCount: number }

function layout(m: Metric, spec: HistogramSpec, histBucketMs: number): Layout {
  const perDay = DAY_MS / histBucketMs;
  const counts = new Map<number, Uint32Array>();
  const vi = VAL[m];
  const ti = TIME[m];
  for (let i = 0; i < n; i++) {
    const v = samples[i * COLS + vi]!;
    if (v !== v) continue;
    const day = samples[i * COLS]!;
    const t = samples[i * COLS + ti]! - day * DAY_MS;
    const b = Math.floor(t / histBucketMs);
    const bin = binIndex(spec, v);
    const rep = samples[i * COLS + 1]!;
    for (const s of [0, rep + 1]) {
      const key = (day * perDay + b) * SERIES + s;
      let c = counts.get(key);
      if (!c) counts.set(key, (c = new Uint32Array(spec.bins)));
      c[bin]!++;
    }
  }
  let nnz = 0, shiftNnz = 0, maxCount = 0;
  const s0 = 6.5 * HOUR_MS, s1 = 18 * HOUR_MS;
  for (const [key, c] of counts) {
    const b = Math.floor(key / SERIES) % perDay;
    const inShift = b * histBucketMs >= s0 && b * histBucketMs < s1;
    for (let i = 0; i < c.length; i++) {
      if (c[i]! > 0) {
        nnz++;
        if (inShift) shiftNnz++;
        if (c[i]! > maxCount) maxCount = c[i]!;
      }
    }
  }
  const rows = perDay * WEEK_DAYS * SERIES;
  const shiftRows = Math.round(((s1 - s0) / histBucketMs) * WEEK_DAYS * SERIES);
  return { rows, shiftRows, nnz, shiftNnz, maxCount };
}

console.log('\n## Histogram blocks per week (ttft + tpot + e2e, 9 series), MB');
console.log('histBucket  bins(x current)  denseU32 day/shift  denseU16 day/shift  CSR day/shift  maxCount');
for (const hb of [60_000, 300_000]) {
  for (const k of [0, 2, 4]) {
    let d32 = 0, d32s = 0, csr = 0, csrs = 0, maxC = 0;
    let binsDesc = '';
    for (const m of ['ttft', 'tpot', 'e2e'] as Metric[]) {
      const { spec } = variants(m)[k]!;
      binsDesc += `${m}:${spec.bins} `;
      const L = layout(m, spec, hb);
      d32 += L.rows * spec.bins * 4;
      d32s += L.shiftRows * spec.bins * 4;
      const idxBytes = spec.bins <= 256 ? 1 : 2;
      const cntBytes = L.maxCount <= 65535 ? 2 : 4;
      csr += (L.rows + 1) * 4 + L.nnz * (idxBytes + cntBytes);
      csrs += (L.shiftRows + 1) * 4 + L.shiftNnz * (idxBytes + cntBytes);
      maxC = Math.max(maxC, L.maxCount);
    }
    console.log(`${hb / 1000}s  ${binsDesc.padEnd(26)}  ${mb(d32).padStart(7)} / ${mb(d32s).padStart(6)}   ${mb(d32 / 2).padStart(7)} / ${mb(d32s / 2).padStart(6)}   ${mb(csr).padStart(6)} / ${mb(csrs).padStart(5)}   ${maxC}`);
  }
}

// ---------- percentile error ----------
interface WindowType { name: string; widthMs: number; perReplica: boolean; minN: [number, number, number] }
const WINDOWS: WindowType[] = [
  { name: 'replica x 60s', widthMs: 60_000, perReplica: true, minN: [10, 20, 100] },
  { name: 'fleet x 60s', widthMs: 60_000, perReplica: false, minN: [10, 20, 100] },
  { name: 'fleet x 5min', widthMs: 300_000, perReplica: false, minN: [10, 20, 100] },
  { name: 'fleet x 1h', widthMs: HOUR_MS, perReplica: false, minN: [10, 20, 100] },
  { name: 'fleet x day', widthMs: DAY_MS, perReplica: false, minN: [10, 20, 100] },
];
const QS = [0.5, 0.9, 0.99];

function groups(m: Metric, w: WindowType): Map<number, number[]> {
  const g = new Map<number, number[]>();
  const vi = VAL[m];
  const ti = TIME[m];
  for (let i = 0; i < n; i++) {
    const v = samples[i * COLS + vi]!;
    if (v !== v) continue;
    const day = samples[i * COLS]!;
    const b = Math.floor((samples[i * COLS + ti]! - day * DAY_MS) / w.widthMs);
    const key = (day * 1e6 + b) * SERIES + (w.perReplica ? samples[i * COLS + 1]! + 1 : 0);
    let arr = g.get(key);
    if (!arr) g.set(key, (arr = []));
    arr.push(v);
  }
  return g;
}

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

for (const m of ['ttft', 'tpot', 'e2e'] as Metric[]) {
  console.log(`\n## ${m} percentile relative error (%): median / p95 / max over windows with enough samples`);
  const specs = variants(m);
  const gs = WINDOWS.map((w) => ({ w, g: [...groups(m, w).values()].map((xs) => Float64Array.from(xs).sort()) }));
  console.log(`window          ${QS.map((q) => `p${q * 100}`.padEnd(8)).join('')}  windows(p50/p90/p99)`);
  for (const { name, spec } of specs) {
    console.log(`  spec ${name}`);
    for (const { w, g } of gs) {
      const cells: string[] = [];
      const counts: number[] = [];
      QS.forEach((q, qi) => {
        const errs: number[] = [];
        for (const sorted of g) {
          if (sorted.length < w.minN[qi]!) continue;
          const exact = exactQuantile(sorted, q);
          const c = new Uint32Array(spec.bins);
          for (let i = 0; i < sorted.length; i++) c[binIndex(spec, sorted[i]!)]!++;
          const est = quantile(spec, c, 0, q);
          errs.push(Math.abs(est - exact) / exact);
        }
        counts.push(errs.length);
        cells.push(errs.length ? `${(pct(errs, 0.5) * 100).toFixed(1)}/${(pct(errs, 0.95) * 100).toFixed(1)}/${(pct(errs, 1) * 100).toFixed(1)}` : '-');
      });
      console.log(`    ${w.name.padEnd(14)} ${cells.map((c) => c.padEnd(16)).join('')} ${counts.join('/')}`);
    }
  }
}
