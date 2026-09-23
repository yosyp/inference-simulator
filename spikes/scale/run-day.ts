// S1 spike: run one Server B day and report speed, event counts, and knee statistics per window.
// pnpm exec tsx spikes/scale/run-day.ts [--day=2] [--spa=16] [--load=1] [--detail=all|tracked|none]
//   [--prefix|--prefix=owner] [--double-keys] [--no-metrics] [--chunk=60000] [--window=3600000] [--json]

import { HOUR_MS } from '../../src/engine/time.ts';
import { args, configFromArgs, exactQuantile, fleetScalarMean, fleetScalarSum, hhmm, loadCalibration, nowMs } from './common.ts';
import { createDay, type Counters } from './engine.ts';

const a = args();
const cfg = configFromArgs(a);
const cal = loadCalibration();
const day = Number(a.day ?? 2);
const chunkMs = Number(a.chunk ?? 60_000);
const windowMs = Number(a.window ?? HOUR_MS);
const nWindows = Math.round((24 * HOUR_MS) / windowMs);
const detail = (a.detail ?? 'all') as 'all' | 'tracked' | 'none';
const run = createDay(cfg, cal, day, {
  detail,
  trackedAnalyst: 7,
  prefixCache: a.prefix === 'true' || a.prefix === 'owner',
  prefixSmiKeys: a['double-keys'] !== 'true',
  prefixImpl: a.prefix === 'owner' ? 'owner' : 'map',
  recordMetrics: a['no-metrics'] !== 'true',
});

interface HourRow {
  hour: number;
  wallMs: number;
  arrivals: number;
  finishes: number;
  steps: number;
  segments: number;
  heapEvents: number;
  preemptions: number;
  timeouts: number;
  kv: number;
  running: number;
  waiting: number;
  busy: number;
  ttft: number[];
  reqSteps: number;
  /** Fraction of replica-buckets whose max KV use reached 95%. */
  kvFull: number;
}

const rows: HourRow[] = [];
const dayStart = run.state.dayStartMs;
const C = run.state.counters;
let prev: Counters = { ...C };
const cumWallByHour: number[] = [];
let cumWall = 0;
const t0 = nowMs();
for (let h = 0; h < nWindows; h++) {
  const row: HourRow = {
    hour: h, wallMs: 0, arrivals: 0, finishes: 0, steps: 0, segments: 0, heapEvents: 0,
    preemptions: 0, timeouts: 0, kv: 0, running: 0, waiting: 0, busy: 0, ttft: [], reqSteps: 0, kvFull: 0,
  };
  let fullN = 0, repBuckets = 0;
  let kvS = 0, runS = 0, waitS = 0, busyS = 0, n = 0;
  for (let t = dayStart + h * windowMs; t < dayStart + (h + 1) * windowMs; t += chunkMs) {
    const w0 = nowMs();
    const chunk = run.advance(t + chunkMs);
    row.wallMs += nowMs() - w0;
    if (chunk.scalars.count > 0) {
      kvS += fleetScalarMean(chunk, 'kvUsedFrac') * chunk.scalars.count;
      runS += fleetScalarMean(chunk, 'running') * chunk.scalars.count;
      waitS += fleetScalarMean(chunk, 'waiting') * chunk.scalars.count;
      busyS += fleetScalarSum(chunk, 'busyMs');
      n += chunk.scalars.count;
      const mx = chunk.scalars.data.kvUsedFracMax;
      for (let b = 0; b < chunk.scalars.count; b++) {
        for (let s = 1; s < chunk.scalars.series; s++) {
          repBuckets++;
          if (mx[b * chunk.scalars.series + s]! >= 0.95) fullN++;
        }
      }
    }
    const r = chunk.requests;
    for (let i = 0; i < r.count; i++) {
      const ft = r.firstTokenMs[i]!;
      if (ft === ft) row.ttft.push(ft - r.arriveMs[i]!);
    }
  }
  cumWall += row.wallMs;
  cumWallByHour.push(cumWall);
  row.arrivals = C.arrivals - prev.arrivals;
  row.finishes = C.finishes - prev.finishes;
  row.steps = C.steps - prev.steps;
  row.segments = C.segments - prev.segments;
  row.heapEvents = C.heapEvents - prev.heapEvents;
  row.preemptions = C.preemptions - prev.preemptions;
  row.timeouts = C.timeouts - prev.timeouts;
  row.reqSteps = C.reqSteps - prev.reqSteps;
  row.kv = n ? kvS / n : 0;
  row.running = n ? runS / n : 0;
  row.waiting = n ? waitS / n : 0;
  row.busy = busyS / (windowMs * cfg.replicas);
  row.kvFull = repBuckets ? fullN / repBuckets : 0;
  prev = { ...C };
  rows.push(row);
}
const totalWall = nowMs() - t0;

const R = cfg.replicas;
const fmt = (x: number, d = 0) => x.toFixed(d).padStart(8);
if (a.json !== 'true') {
  console.log(`day ${day}  load ${cfg.loadMultiplier}  spa ${cfg.sessionsPerAnalystPerDay}  detail ${detail}  prefix ${a.prefix === 'true'}  metrics ${a['no-metrics'] !== 'true'}`);
  console.log('hour     wallMs  simS/wS  req/s/rep   kv%  run/rep wait/rep  busy%  ttftP50  ttftP99  preempt timeouts  steps/seg  reqSteps/step kvFull%');
  for (const r of rows) {
    if (r.arrivals === 0 && r.steps === 0) continue;
    const sorted = Float64Array.from(r.ttft).sort();
    console.log(
      `${hhmm(r.hour * windowMs)} ${fmt(r.wallMs)} ${fmt(windowMs / Math.max(r.wallMs, 1e-9))} ${fmt(r.arrivals / (windowMs / 1000) / R, 2)} ${fmt(r.kv * 100, 1)} ${fmt(r.running / R, 1)} ${fmt(r.waiting / R, 1)} ${fmt(r.busy * 100, 1)} ${fmt(exactQuantile(sorted, 0.5))} ${fmt(exactQuantile(sorted, 0.99))} ${fmt(r.preemptions)} ${fmt(r.timeouts)} ${fmt(r.steps / Math.max(1, r.segments), 2)} ${fmt(r.reqSteps / Math.max(1, r.steps), 1)} ${fmt(r.kvFull * 100, 1)}`,
    );
  }
  console.log('cumulative wall ms from 00:00 to end of window:', cumWallByHour.map((w, h) => `${hhmm((h + 1) * windowMs)}=${w.toFixed(0)}`).filter((_, h) => ((h + 1) * windowMs) % HOUR_MS === 0).slice(5, 18).join(' '));
}
const summary = {
  day, load: cfg.loadMultiplier, spa: cfg.sessionsPerAnalystPerDay, detail, prefix: a.prefix === 'true',
  totalWallMs: totalWall, counters: C, cumWallByHour,
  hours: rows.map((r) => ({ ...r, ttft: undefined, ttftP50: exactQuantile(Float64Array.from(r.ttft).sort(), 0.5), ttftP99: exactQuantile(Float64Array.from(r.ttft).sort(), 0.99) })),
};
if (a.json === 'true') console.log(JSON.stringify(summary));
else console.log(JSON.stringify({ totalWallMs: Math.round(totalWall), ...C }));
