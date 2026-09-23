// pnpm perf: the engine budgets of 00-build §8 on Server B at knee load (S1: 8 replicas × 400
// analysts, 16 sessions per analyst per day, 5 turns; the fixture config otherwise; provisional
// calibration). Runs the real worker host in this process with a MessageChannel scheduler.
//
//   P1  init → the first chunk covering a Wednesday 09:30 entry point (K30)
//   P2  fork → the first chunk of the new revision, on the focus day, sent while the host is busy
//   P3  simulated seconds per wall second at the 10:30 peak and over the whole day (headless)
//   P4  peak heap for a whole week: the results store (U8) fed as the main thread would, plus the
//       worker's state (checkpoints, live runs), measured after GC. Chrome adds a page baseline
//       that Node can't see; S1 assumed 100–150 MB.
//
// Usage: pnpm perf [--skip-week]    Node timings on this host; Chrome at X1 is the reference.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { calibration } from '../src/data/calibration.ts';
import type { Patch, SimConfig } from '../src/engine/api.ts';
import { runHeadlessDay } from '../src/engine/headless.ts';
import { engine } from '../src/engine/index.ts';
import type { ResultChunk } from '../src/engine/results.ts';
import { DAY_MS, simMs, type SimMs } from '../src/engine/time.ts';
import { fixtureSimConfig } from '../src/fixtures/scenarios.ts';
import { createResultsStore } from '../src/playback/index/index.ts';
import { estimateBytes } from '../src/worker/checkpoints.ts';
import { createEngineHost, type EngineHost } from '../src/worker/host.ts';
import type { MainToWorker, WorkerScenario, WorkerToMain } from '../src/worker/protocol.ts';
import { macrotaskScheduler } from '../src/worker/scheduler.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const MB = 1024 * 1024;
const DAY = 2;
const ENTRY = simMs(DAY, 9, 30);

function kneeConfig(): SimConfig {
  const c = fixtureSimConfig(8);
  return {
    ...c,
    analystsPerReplica: 400,
    sessionsPerAnalystPerDay: 16,
    tunable: { ...c.tunable, turnsPerSessionMean: 5 },
  };
}

const config = kneeConfig();
const scenario: WorkerScenario = {
  config,
  baselinePatches: [],
  tracked: { rule: 'spansMoment', momentMs: ENTRY, minTurnsAfter: 2 },
};

/** Heap plus ArrayBuffer backing stores after GC. Node frees dead backing stores lazily, so it
 * collects a few times with a turn of the event loop between. */
async function heapMb(): Promise<number> {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const m = process.memoryUsage();
  return (m.heapUsed + m.arrayBuffers) / MB;
}

interface Live {
  host: EngineHost;
  send(msg: MainToWorker): void;
  /** Resolves with performance.now() when a posted message satisfies `test`. */
  when(test: (m: WorkerToMain) => boolean): Promise<number>;
  close(): void;
}

/** A host on a real macrotask scheduler; every message goes to `onMessage` as the main thread's. */
function liveHost(onMessage: (m: WorkerToMain) => void = () => {}): Live {
  const sched = macrotaskScheduler();
  const waiters: { test: (m: WorkerToMain) => boolean; resolve: (t: number) => void }[] = [];
  const host = createEngineHost({
    post: (msg, transfer) => {
      const copy = structuredClone(msg, { transfer });
      if (copy.type === 'error') {
        console.error(`engine error: ${copy.message}`);
        process.exit(1);
      }
      onMessage(copy);
      const now = performance.now();
      for (const w of [...waiters]) {
        if (w.test(copy)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(now);
        }
      }
    },
    schedule: sched.schedule,
  });
  return {
    host,
    send: (msg) => host.handle(structuredClone(msg)),
    when: (test) => new Promise((resolve) => waiters.push({ test, resolve })),
    close() {
      host.dispose();
      sched.close();
    },
  };
}

const init = (focusMs: SimMs): MainToWorker => ({
  type: 'init',
  runId: 1,
  scenario,
  calibration,
  focusMs,
});

const covers = (t: SimMs) => (m: WorkerToMain) =>
  m.type === 'chunk' && m.chunk.fromMs <= t && t < m.chunk.toMs;

// --- P1 and P4: one clean week, fed into the results store -------------------------------------

async function week(skipWeek: boolean) {
  const base = await heapMb();
  const results = createResultsStore(config.replicas);
  const samples: Promise<number>[] = [];
  const live = liveHost((m) => {
    if (m.type === 'chunk') results.addChunk(m.chunk);
    else if (m.type === 'progress') results.setComputed(m.computed);
    else if (m.type === 'dayComplete') {
      results.addRollup(m.day, m.rollup);
      samples.push(heapMb());
    }
  });
  const t0 = performance.now();
  const ready = live.when((m) => m.type === 'ready');
  const first = live.when(covers(ENTRY));
  const dayDone = live.when((m) => m.type === 'dayComplete' && m.day === DAY);
  const all = live.when((m) => m.type === 'dayComplete' && m.day === 1);
  live.send(init(ENTRY));
  const tReady = (await ready) - t0;
  const tFirst = (await first) - t0;
  const tDay = (await dayDone) - t0;
  if (skipWeek) {
    live.close();
    return { tReady, tFirst, tDay, week: null };
  }
  const tWeek = (await all) - t0;
  const total = (await heapMb()) - base;
  const peak = Math.max(total, ...(await Promise.all(samples)).map((x) => x - base));
  live.close();
  const mainOnly = (await heapMb()) - base;
  void results.index.version;
  return {
    tReady,
    tFirst,
    tDay,
    week: { tWeek, peak, total, mainOnly, worker: total - mainOnly },
  };
}

// --- P2: forks on the focus day, sent while the host computes other days ------------------------

async function forks() {
  const live = liveHost();
  const done = live.when((m) => m.type === 'dayComplete' && m.day === DAY);
  live.send(init(simMs(DAY, 10)));
  await done;
  const patches: [string, Patch][] = [
    [
      'lasting, 14 min after a checkpoint',
      { kind: 'set', atMs: simMs(DAY, 10, 44, 30), changes: { routingPolicy: 'leastOutstanding' } },
    ],
    [
      'one-shot crash, 14 min after one',
      { kind: 'event', atMs: simMs(DAY, 11, 59, 30), event: { type: 'crash', replica: 3 } },
    ],
    [
      'one-shot long prompt at a checkpoint',
      {
        kind: 'event',
        atMs: simMs(DAY, 13, 0, 20),
        event: {
          type: 'extraRequest',
          analyst: 'tracked',
          promptTokens: 30_000,
          outputTokens: 300,
        },
      },
    ],
  ];
  const out: { label: string; ms: number }[] = [];
  for (const [i, [label, patch]] of patches.entries()) {
    const revision = i + 1;
    const first = live.when((m) => m.type === 'chunk' && m.revision === revision);
    // Arrives as a message while a unit of other work is under way.
    const sent = await new Promise<number>((resolve) =>
      setTimeout(() => {
        const t = performance.now();
        live.send({ type: 'fork', runId: 1, revision, patch });
        resolve(t);
      }, 0),
    );
    out.push({ label, ms: (await first) - sent });
    // Let the fork's day finish again before the next one.
    await live.when((m) => m.type === 'dayComplete' && m.day === DAY && m.revision === revision);
  }
  live.close();
  return out;
}

// --- P3: engine speed, headless ----------------------------------------------------------------

function speed() {
  const chunks: { chunk: ResultChunk; wall: number }[] = [];
  const day = runHeadlessDay(
    {
      config,
      calibration,
      detail: 'tracked',
      keepChunks: false,
      onChunk: (chunk, wall) => chunks.push({ chunk, wall }),
      now: () => performance.now(),
    },
    DAY,
    null,
  );
  const window = (from: SimMs, to: SimMs) => {
    const wall = chunks
      .filter((c) => c.chunk.fromMs >= from && c.chunk.toMs <= to)
      .reduce((s, c) => s + c.wall, 0);
    return (to - from) / wall;
  };
  const peak = window(simMs(DAY, 10, 30), simMs(DAY, 11));
  const shift = window(simMs(DAY, 7), simMs(DAY, 17));
  const whole = DAY_MS / day.wallMs;
  // One checkpoint at the peak: cost and size.
  const run = engine.createDayRun(day.input);
  run.advance(simMs(DAY, 10, 30));
  const c0 = performance.now();
  const cp = run.checkpoint();
  const cloneMs = performance.now() - c0;
  const r0 = performance.now();
  engine.restoreDayRun(day.input, cp);
  const restoreMs = performance.now() - r0;
  const served = day.rollup!.reduce((s, r) => s + r.requestsServed, 0);
  return {
    peak,
    shift,
    whole,
    dayWall: day.wallMs,
    served,
    cloneMs,
    restoreMs,
    cpMb: estimateBytes(cp.state) / MB,
  };
}

// --- Report ------------------------------------------------------------------------------------

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

async function main() {
  const skipWeek = process.argv.includes('--skip-week');
  console.log(
    `Server B knee: ${config.replicas} replicas × ${config.analystsPerReplica} analysts, ${config.sessionsPerAnalystPerDay} sessions/analyst/day, ${config.tunable.turnsPerSessionMean} turns; calibration ${calibration.status}; Node ${process.version}\n`,
  );
  const s = speed();
  console.log(
    `P3 done: Wednesday in ${(s.dayWall / 1000).toFixed(1)} s, ${s.served} requests served`,
  );
  const w = await week(skipWeek);
  console.log(`P1/P4 done${w.week ? `: week in ${(w.week.tWeek / 1000).toFixed(1)} s` : ''}`);
  const f = await forks();
  console.log('P2 done\n');

  const p2 = Math.max(...f.map((x) => x.ms));
  const baseline = [100, 150];
  const lines = [
    row(['Budget', 'Target', 'Measured', 'Result']),
    row(['---', '---', '---', '---']),
    row([
      'P1 init → first chunk covering Wed 09:30',
      '≤ 3 s',
      `${(w.tFirst / 1000).toFixed(2)} s (ready with sessionsByDay at ${(w.tReady / 1000).toFixed(2)} s)`,
      w.tFirst <= 3000 ? 'pass' : 'FAIL',
    ]),
    row([
      'P2 fork → first chunk (focus day, host busy)',
      '≤ 1 s',
      `${(p2 / 1000).toFixed(2)} s worst (${f.map((x) => `${x.label}: ${(x.ms / 1000).toFixed(2)} s`).join('; ')})`,
      p2 <= 1000 ? 'pass' : 'FAIL',
    ]),
    row([
      'P3 engine speed at the 10:30 peak (10:30–11:00)',
      '≥ 1,000×',
      `${Math.round(s.peak).toLocaleString('en-US')}× (shift 07–17: ${Math.round(s.shift).toLocaleString('en-US')}×; whole day: ${Math.round(s.whole).toLocaleString('en-US')}×)`,
      s.peak >= 1000 ? 'pass' : 'FAIL',
    ]),
  ];
  if (w.week) {
    const lo = w.week.peak + baseline[0]!;
    const hi = w.week.peak + baseline[1]!;
    lines.push(
      row([
        'P4 peak memory, week (main + worker heap)',
        '≤ 400 MB',
        `${w.week.peak.toFixed(0)} MB peak (results store ${w.week.mainOnly.toFixed(0)} MB, worker ${w.week.worker.toFixed(0)} MB at the end); ${lo.toFixed(0)}–${hi.toFixed(0)} MB with a 100–150 MB page baseline`,
        hi <= 400 ? 'pass' : lo <= 400 ? 'pass at 100 MB baseline only' : 'FAIL',
      ]),
    );
  }
  console.log(lines.join('\n'));
  console.log(
    `\nAlso: Wednesday computed from its morning in ${(w.tDay / 1000).toFixed(1)} s by the host; checkpoint at 10:30 ≈ ${s.cpMb.toFixed(1)} MB, clone ${s.cloneMs.toFixed(1)} ms, restore ${s.restoreMs.toFixed(1)} ms.`,
  );
}

await main();
