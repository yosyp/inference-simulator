// S1 spike: checkpoint cost. structuredClone time and serialized size of the engine state at
// several times of day, a breakdown by part, and a restore check (clone at 10:30, run both to
// 11:00, compare). pnpm exec tsx spikes/scale/checkpoint.ts [--spa=16] [--prefix|--prefix=owner]

import { serialize } from 'node:v8';
import { HOUR_MS, MINUTE_MS } from '../../src/engine/time.ts';
import { args, configFromArgs, hhmm, loadCalibration, nowMs } from './common.ts';
import { createDay, type DayState, type EngineOptions } from './engine.ts';

const a = args();
const cfg = configFromArgs(a);
const cal = loadCalibration();
const day = 2;
const opts: EngineOptions = {
  detail: 'tracked',
  trackedAnalyst: 7,
  prefixCache: a.prefix === 'true' || a.prefix === 'owner',
  prefixImpl: a.prefix === 'owner' ? 'owner' : 'map',
  recordMetrics: true,
};
const run = createDay(cfg, cal, day, opts);
const d0 = run.state.dayStartMs;

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

function measure(cp: DayState) {
  const size = serialize(cp).length;
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = nowMs();
    structuredClone(cp);
    times.push(nowMs() - t);
  }
  let running = 0, waiting = 0, blockRefs = 0;
  for (const r of cp.replicas) {
    running += r.running.length;
    waiting += r.waiting.length;
    for (const q of r.running) blockRefs += q.blocks.length;
  }
  const parts = {
    blockTables: serialize(cp.replicas.map((r) => [r.ref, r.prev, r.next])).length,
    prefixIndex: serialize(cp.replicas.map((r) => [r.key, r.keyMap, r.owner, r.ownerIdx, r.nextInSeq])).length,
    queuesAndRequests: serialize(cp.replicas.map((r) => [r.running, r.waiting])).length,
    sessions: serialize(cp.sessions).length,
    heapAndTimeouts: serialize([cp.heap, cp.tq]).length,
    recorder: serialize(cp.rec).length,
  };
  return { size, cloneMs: median(times), running, waiting, sessions: cp.sessions.size, heap: cp.heap.length, blockRefs, parts };
}

const rows: string[] = [];
const results: Record<string, unknown> = {};
for (const hh of [7.5, 9, 10.5, 11, 14]) {
  run.advance(d0 + hh * HOUR_MS);
  const cp = run.checkpointState();
  const m = measure(cp);
  results[hhmm(hh * HOUR_MS)] = m;
  rows.push(
    `${hhmm(hh * HOUR_MS)}  size ${(m.size / 1e6).toFixed(2)} MB  clone ${m.cloneMs.toFixed(2)} ms  running ${m.running}  waiting ${m.waiting}  sessions ${m.sessions}  parts(KB) ${Object.entries(m.parts).map(([k, v]) => `${k}=${(v / 1e3).toFixed(0)}`).join(' ')}`,
  );
}
console.log(rows.join('\n'));

// Restore check: a fresh run to 10:30, checkpoint, then (A) continue and (B) restore a clone; both to 11:00.
const runA = createDay(cfg, cal, day, opts);
runA.advance(d0 + 10.5 * HOUR_MS);
const cp = structuredClone(runA.checkpointState());
const runB = createDay(cfg, cal, day, opts, structuredClone(cp));
const ca = runA.advance(d0 + 11 * HOUR_MS);
const t = nowMs();
const cb = runB.advance(d0 + 11 * HOUR_MS);
const replayMs = nowMs() - t;
const same =
  JSON.stringify(runA.state.counters) === JSON.stringify(runB.state.counters) &&
  ca.requests.count === cb.requests.count &&
  ca.requests.endMs.every((v, i) => v === cb.requests.endMs[i]) &&
  ca.scalars.data.kvUsedFrac.every((v, i) => v === cb.scalars.data.kvUsedFrac[i]);
console.log(`restore check 10:30 -> 11:00: identical=${same}; replay of 30 sim min took ${replayMs.toFixed(0)} ms`);

// Replay cost for a fork: time to advance k minutes from a peak checkpoint.
for (const mins of [5, 15, 30]) {
  const r = createDay(cfg, cal, day, opts, structuredClone(cp));
  const t1 = nowMs();
  r.advance(d0 + 10.5 * HOUR_MS + mins * MINUTE_MS);
  console.log(`replay ${mins} sim min from 10:30 checkpoint: ${(nowMs() - t1).toFixed(0)} ms`);
}
if (a.json === 'true') console.log(JSON.stringify(results));
