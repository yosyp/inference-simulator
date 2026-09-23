// S1 spike: writes metrics into the contract's ResultChunk layout (src/engine/results.ts).
// Scalars and histograms accumulate for the current bucket only and flush into growable output
// buffers; request records and transitions go into growable typed-array columns.

import { binIndex, HISTOGRAM_METRICS, HISTOGRAM_SPECS, type HistogramMetric } from '../../src/engine/histogram.ts';
import {
  allocHistogramBlock,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  SCALAR_METRIC_NAMES,
  SCALAR_METRICS,
  type ResultChunk,
  type ScalarMetric,
} from '../../src/engine/results.ts';
import type { DayIndex } from '../../src/engine/time.ts';

export const M = SCALAR_METRIC_NAMES.length;
export const MI = Object.fromEntries(SCALAR_METRIC_NAMES.map((m, i) => [m, i])) as Record<ScalarMetric, number>;
const IS_MEAN = SCALAR_METRIC_NAMES.map((m) => SCALAR_METRICS[m] === 'mean');
const IS_MAX = SCALAR_METRIC_NAMES.map((m) => SCALAR_METRICS[m] === 'max');

type Grow<T> = { a: T; n: number };

function growF64(g: Grow<Float64Array>, need: number): void {
  if (need <= g.a.length) return;
  const b = new Float64Array(Math.max(need, g.a.length * 2));
  b.set(g.a);
  g.a = b;
}

/** Growable columns for request records (RequestBlock) and transitions (TransitionBlock). */
export interface Columns {
  n: number;
  cap: number;
  u32: Record<string, Uint32Array>;
  f64: Record<string, Float64Array>;
  u16: Record<string, Uint16Array>;
  u8: Record<string, Uint8Array>;
  i8: Record<string, Int8Array>;
}

const REQ_COLS = {
  u32: ['id', 'session', 'analyst', 'promptTokens', 'cachedTokens', 'outputTokens'],
  f64: ['arriveMs', 'dispatchMs', 'firstTokenMs', 'endMs'],
  u16: ['turn', 'preemptions'],
  u8: ['attempt', 'outcome'],
  i8: ['replica', 'prevReplica'],
};
const TR_COLS = { u32: ['request', 'analyst'], f64: ['atMs'], u16: [], u8: ['state'], i8: ['replica'] };

function makeColumns(spec: typeof REQ_COLS, cap: number): Columns {
  const c: Columns = { n: 0, cap, u32: {}, f64: {}, u16: {}, u8: {}, i8: {} };
  for (const k of spec.u32) c.u32[k] = new Uint32Array(cap);
  for (const k of spec.f64) c.f64[k] = new Float64Array(cap);
  for (const k of spec.u16) c.u16[k] = new Uint16Array(cap);
  for (const k of spec.u8) c.u8[k] = new Uint8Array(cap);
  for (const k of spec.i8) c.i8[k] = new Int8Array(cap);
  return c;
}

function ensure(c: Columns): void {
  if (c.n < c.cap) return;
  const cap = c.cap * 2;
  for (const k in c.u32) { const b = new Uint32Array(cap); b.set(c.u32[k]!); c.u32[k] = b; }
  for (const k in c.f64) { const b = new Float64Array(cap); b.set(c.f64[k]!); c.f64[k] = b; }
  for (const k in c.u16) { const b = new Uint16Array(cap); b.set(c.u16[k]!); c.u16[k] = b; }
  for (const k in c.u8) { const b = new Uint8Array(cap); b.set(c.u8[k]!); c.u8[k] = b; }
  for (const k in c.i8) { const b = new Int8Array(cap); b.set(c.i8[k]!); c.i8[k] = b; }
  c.cap = cap;
}

export interface Recorder {
  enabled: boolean;
  series: number;
  bucketMs: number;
  histBucketMs: number;
  /** Current scalar bucket accumulators: [series][metric]. */
  cur: Float64Array;
  curBucketStartMs: number;
  /** Flushed scalar buckets since the last emit: [bucket][metric][series]. */
  outScalars: Grow<Float64Array>;
  outScalarCount: number;
  outScalarStartMs: number;
  /** Current histogram bucket counts per metric: [series][bin]. */
  hcur: Record<HistogramMetric, Uint32Array>;
  curHistStartMs: number;
  outHist: Record<HistogramMetric, Uint32Array[]>;
  outHistStartMs: number;
  req: Columns;
  tr: Columns;
}

export function makeRecorder(replicas: number, bucketMs: number, histBucketMs: number, dayStartMs: number, enabled: boolean): Recorder {
  const series = replicas + 1;
  const hcur = {} as Record<HistogramMetric, Uint32Array>;
  const outHist = {} as Record<HistogramMetric, Uint32Array[]>;
  for (const m of HISTOGRAM_METRICS) {
    hcur[m] = new Uint32Array(series * HISTOGRAM_SPECS[m].bins);
    outHist[m] = [];
  }
  return {
    enabled,
    series,
    bucketMs,
    histBucketMs,
    cur: new Float64Array(series * M),
    curBucketStartMs: dayStartMs,
    outScalars: { a: new Float64Array(1024), n: 0 },
    outScalarCount: 0,
    outScalarStartMs: dayStartMs,
    hcur,
    curHistStartMs: dayStartMs,
    outHist,
    outHistStartMs: dayStartMs,
    req: makeColumns(REQ_COLS, 1024),
    tr: makeColumns(TR_COLS, 4096),
  };
}

/** Finalizes the current scalar bucket (levels already integrated to its end) and starts the next. */
export function flushScalarBucket(rec: Recorder, replicas: number, kvLevels: Float64Array): void {
  const { cur, series, bucketMs } = rec;
  // Replica means.
  for (let s = 1; s < series; s++) {
    const base = s * M;
    for (let m = 0; m < M; m++) if (IS_MEAN[m]) cur[base + m]! /= bucketMs;
  }
  // Fleet series: sums add; means add except kvUsedFrac (mean across replicas); max is max.
  const f = 0;
  for (let m = 0; m < M; m++) {
    if (m === MI.offered || m === MI.organic || m === MI.rejected || m === MI.retries || m === MI.abandonedSessions) continue;
    if (m === MI.readyReplicas) { cur[f * M + m] = replicas; continue; }
    let v = IS_MAX[m] ? 0 : 0;
    for (let s = 1; s < series; s++) {
      const x = cur[s * M + m]!;
      v = IS_MAX[m] ? Math.max(v, x) : v + x;
    }
    cur[f * M + m] = m === MI.kvUsedFrac ? v / replicas : v;
  }
  const off = rec.outScalars.n;
  growF64(rec.outScalars, off + series * M);
  const out = rec.outScalars.a;
  for (let m = 0; m < M; m++) for (let s = 0; s < series; s++) out[off + m * series + s] = cur[s * M + m]!;
  rec.outScalars.n = off + series * M;
  rec.outScalarCount++;
  cur.fill(0);
  // Max-level metrics restart from the current level.
  for (let s = 1; s < series; s++) cur[s * M + MI.kvUsedFracMax] = kvLevels[s - 1]!;
  rec.curBucketStartMs += bucketMs;
}

export function flushHistBucket(rec: Recorder): void {
  for (const m of HISTOGRAM_METRICS) {
    rec.outHist[m].push(rec.hcur[m].slice());
    rec.hcur[m].fill(0);
  }
  rec.curHistStartMs += rec.histBucketMs;
}

const TTFT = HISTOGRAM_SPECS.ttft;
const TPOT = HISTOGRAM_SPECS.tpot;
const E2E = HISTOGRAM_SPECS.e2e;

export function recordTtft(rec: Recorder, replica: number, ms: number): void {
  const b = binIndex(TTFT, ms);
  rec.hcur.ttft[b]!++;
  rec.hcur.ttft[(replica + 1) * TTFT.bins + b]!++;
}
export function recordFinish(rec: Recorder, replica: number, tpotMs: number, e2eMs: number): void {
  if (tpotMs >= 0) {
    const b = binIndex(TPOT, tpotMs);
    rec.hcur.tpot[b]!++;
    rec.hcur.tpot[(replica + 1) * TPOT.bins + b]!++;
  }
  const e = binIndex(E2E, e2eMs);
  rec.hcur.e2e[e]!++;
  rec.hcur.e2e[(replica + 1) * E2E.bins + e]!++;
}

export function pushTransition(rec: Recorder, atMs: number, request: number, analyst: number, replica: number, state: number): void {
  const c = rec.tr;
  ensure(c);
  const i = c.n++;
  c.f64.atMs![i] = atMs;
  c.u32.request![i] = request;
  c.u32.analyst![i] = analyst;
  c.i8.replica![i] = replica;
  c.u8.state![i] = state;
}

export interface EndedRequest {
  id: number;
  session: number;
  analyst: number;
  turn: number;
  replica: number;
  prevReplica: number;
  arriveMs: number;
  dispatchMs: number;
  firstTokenMs: number;
  endMs: number;
  promptTokens: number;
  cachedTokens: number;
  generated: number;
  preemptions: number;
}

export function pushRequest(rec: Recorder, r: EndedRequest, outcome: number): void {
  const c = rec.req;
  ensure(c);
  const i = c.n++;
  c.u32.id![i] = r.id;
  c.u32.session![i] = r.session;
  c.u32.analyst![i] = r.analyst;
  c.u16.turn![i] = r.turn;
  c.u8.attempt![i] = 0;
  c.i8.replica![i] = r.replica;
  c.i8.prevReplica![i] = r.prevReplica;
  c.f64.arriveMs![i] = r.arriveMs;
  c.f64.dispatchMs![i] = r.dispatchMs;
  c.f64.firstTokenMs![i] = r.firstTokenMs;
  c.f64.endMs![i] = r.endMs;
  c.u32.promptTokens![i] = r.promptTokens;
  c.u32.cachedTokens![i] = r.cachedTokens;
  c.u32.outputTokens![i] = r.generated;
  c.u16.preemptions![i] = r.preemptions;
  c.u8.outcome![i] = outcome;
}

/** Packs everything recorded since the last emit into a contract-shaped ResultChunk. */
export function emitChunk(rec: Recorder, day: number, fromMs: number, toMs: number, replicas: number, scope: 'all' | 'tracked'): ResultChunk {
  const { series } = rec;
  const sc = allocScalarBlock(rec.outScalarStartMs, rec.bucketMs, rec.outScalarCount, series);
  const out = rec.outScalars.a;
  for (let b = 0; b < rec.outScalarCount; b++) {
    const base = b * series * M;
    for (let m = 0; m < M; m++) {
      const arr = sc.data[SCALAR_METRIC_NAMES[m]!];
      for (let s = 0; s < series; s++) arr[b * series + s] = out[base + m * series + s]!;
    }
  }
  rec.outScalarStartMs += rec.outScalarCount * rec.bucketMs;
  rec.outScalars.n = 0;
  rec.outScalarCount = 0;

  const hn = rec.outHist.ttft.length;
  const hb = allocHistogramBlock(rec.outHistStartMs, rec.histBucketMs, hn, series);
  for (const m of HISTOGRAM_METRICS) {
    const per = series * HISTOGRAM_SPECS[m].bins;
    rec.outHist[m].forEach((a, i) => hb.data[m].set(a, i * per));
    rec.outHist[m] = [];
  }
  rec.outHistStartMs += hn * rec.histBucketMs;

  const rq = allocRequestBlock(scope, rec.req.n);
  const c = rec.req;
  for (const k in c.u32) (rq as unknown as Record<string, Uint32Array>)[k]!.set(c.u32[k]!.subarray(0, c.n));
  for (const k in c.f64) (rq as unknown as Record<string, Float64Array>)[k]!.set(c.f64[k]!.subarray(0, c.n));
  for (const k in c.u16) (rq as unknown as Record<string, Uint16Array>)[k]!.set(c.u16[k]!.subarray(0, c.n));
  for (const k in c.u8) (rq as unknown as Record<string, Uint8Array>)[k]!.set(c.u8[k]!.subarray(0, c.n));
  for (const k in c.i8) (rq as unknown as Record<string, Int8Array>)[k]!.set(c.i8[k]!.subarray(0, c.n));
  c.n = 0;

  const tb = allocTransitionBlock(scope, rec.tr.n);
  const t = rec.tr;
  tb.atMs.set(t.f64.atMs!.subarray(0, t.n));
  tb.request.set(t.u32.request!.subarray(0, t.n));
  tb.analyst.set(t.u32.analyst!.subarray(0, t.n));
  tb.replica.set(t.i8.replica!.subarray(0, t.n));
  tb.state.set(t.u8.state!.subarray(0, t.n));
  t.n = 0;

  return {
    day: day as DayIndex,
    fromMs,
    toMs,
    replicas,
    scalars: sc,
    histograms: hb,
    requests: rq,
    transitions: tb,
    replicaEvents: [],
  };
}
