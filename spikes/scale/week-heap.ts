// S1 spike: heap for a full Server B week (5 independent days) held as ResultChunks, as the main
// thread would hold them after transfer. Each chunk goes through structuredClone with its buffers
// transferred (a stand-in for postMessage).
// node --expose-gc --import tsx spikes/scale/week-heap.ts --detail=all|tracked [--chunk=60000] [--spa=16]

import { chunkTransferables, type ResultChunk } from '../../src/engine/results.ts';
import { DAY_MS, WEEK_DAYS } from '../../src/engine/time.ts';
import { args, chunkBytes, configFromArgs, gc, loadCalibration, mb, mem, nowMs } from './common.ts';
import { createDay } from './engine.ts';

const a = args();
const cfg = configFromArgs(a);
const cal = loadCalibration();
const detail = (a.detail ?? 'all') as 'all' | 'tracked';
const chunkMs = Number(a.chunk ?? 60_000);

gc();
const base = mem();
const store: ResultChunk[] = [];
let transferMs = 0;
let simWall = 0;
let peakDuringRun = 0;
let requests = 0;
for (let day = 0; day < WEEK_DAYS; day++) {
  const run = createDay(cfg, cal, day, { detail, trackedAnalyst: 7, prefixCache: false, recordMetrics: true });
  const d0 = day * DAY_MS;
  for (let t = d0; t < d0 + DAY_MS; t += chunkMs) {
    const w = nowMs();
    const chunk = run.advance(t + chunkMs);
    simWall += nowMs() - w;
    const w2 = nowMs();
    const moved = structuredClone(chunk, { transfer: chunkTransferables(chunk) });
    transferMs += nowMs() - w2;
    store.push(moved);
  }
  requests += run.state.counters.arrivals;
  const m = mem();
  peakDuringRun = Math.max(peakDuringRun, m.heapUsed + m.arrayBuffers);
}
gc();
const after = mem();
const bytes = { scalars: 0, histograms: 0, requests: 0, transitions: 0 };
let recCount = 0;
let trCount = 0;
for (const c of store) {
  const b = chunkBytes(c);
  bytes.scalars += b.scalars;
  bytes.histograms += b.histograms;
  bytes.requests += b.requests;
  bytes.transitions += b.transitions;
  recCount += c.requests.count;
  trCount += c.transitions.count;
}
const heapDelta = after.heapUsed - base.heapUsed;
const abDelta = after.arrayBuffers - base.arrayBuffers;
const typed = bytes.scalars + bytes.histograms + bytes.requests + bytes.transitions;
const out = {
  detail,
  chunkMs,
  spa: cfg.sessionsPerAnalystPerDay,
  chunks: store.length,
  requestsWeek: requests,
  records: recCount,
  transitions: trCount,
  transitionsPerRequest: trCount / Math.max(1, recCount),
  typedBytesMB: { scalars: mb(bytes.scalars), histograms: mb(bytes.histograms), requests: mb(bytes.requests), transitions: mb(bytes.transitions), total: mb(typed) },
  measuredMB: { heapUsedDelta: mb(heapDelta), arrayBuffersDelta: mb(abDelta), total: mb(heapDelta + abDelta), rssAfter: mb(after.rss) },
  jsObjectOverheadMB: mb(heapDelta + abDelta - typed),
  bytesPerRequestRecordsPlusTransitions: (bytes.requests + bytes.transitions) / Math.max(1, recCount),
  MBPerMillionRequests: mb(((bytes.requests + bytes.transitions) / Math.max(1, recCount)) * 1e6),
  engineWallMs: Math.round(simWall),
  transferMs: Math.round(transferMs),
};
console.log(JSON.stringify(out, null, 1));
// Keep the store alive until after measurement.
if (store.length < 0) console.log(store);
