// A toy model on the day runner: open-loop arrivals, a processor-sharing server with a concurrency
// cap (its "next completion" event is recomputed on every change, like a replica's step span), client
// timeouts that abort, a meter that integrates levels per bucket and produces chunks, and injected
// events. It proves the runner's guarantees without E1's RNG (a local keyed hash stands in).

import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch, SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import type { ResultChunk } from '../results.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, dayStartMs, type DayIndex } from '../time.ts';
import { emptyChunk } from './chunk.ts';
import { PATCH_KIND, PRIORITY } from './ids.ts';
import { createLevel, setLevel, takeLevelMean, type Level } from './level.ts';
import { assertPlainData, digestState } from './plain.ts';
import { NO_EVENT } from './queue.ts';
import { advanceInSteps, createDayRunner } from './runner.ts';
import { defineModule, type Ctx, type DayState, type EngineModule } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Toy model

interface ToyLoad {
  /** Organic arrivals so far; keys the gap and work draws. */
  organic: number;
  arriveMs: number[];
  deadlineMs: number[];
  /** 0 pending, then a LOG code: done, timeout, failed. */
  outcome: number[];
  timeoutEv: number[];
  /** Handles this module cancelled; none may ever fire. */
  cancelled: number[];
  /** Flat [atMs, loadMultiplier, timeoutMs] per 'set' patch seen. */
  paramsSeen: number[];
  /** Flat [atMs, code, job]. */
  log: number[];
}

interface ToyServer {
  running: number[];
  waiting: number[];
  waitHead: number;
  /** Remaining work (ms at full rate) by job. */
  remaining: number[];
  /** Time `remaining` was last brought up to date. */
  lastMs: number;
  doneEv: number;
  cancelled: number[];
  inSystem: Level;
  busy: Level;
}

interface ToyMeter {
  meanInSystem: number[];
  busyMs: number[];
  finished: number[];
  finishedOpen: number;
}

declare module './types.ts' {
  interface DayState {
    e2load: ToyLoad;
    e2server: ToyServer;
    e2meter: ToyMeter;
  }
}

const K_ARRIVE = 900;
const K_TIMEOUT = 901;
const K_DONE = 910;
const T_DONE = 950;
const T_FAILED = 951;
const LOG = { arrive: 1, done: 2, timeout: 3, extra: 4, failed: 5 } as const;

const WINDOW_START = 9 * HOUR_MS;
const WINDOW_END = 11 * HOUR_MS;
const MEAN_GAP_MS = 1_500;
const MEAN_WORK_MS = 1_300;
const CAP = 3;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`toy: ${msg}`);
}

function mix32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Keyed uniform in (0, 1): a pure function of (seed, stream, index). */
function u01(seed: number, stream: number, index: number): number {
  return (mix32(mix32(mix32(seed ^ 0x9e3779b9) ^ stream) ^ index) + 0.5) / 4294967296;
}

// Server: plain functions other modules call synchronously.

function accrue(s: ToyServer, nowMs: number): void {
  const n = s.running.length;
  if (n > 0) {
    const d = (nowMs - s.lastMs) / n;
    for (const j of s.running) s.remaining[j] = s.remaining[j]! - d;
  }
  s.lastMs = nowMs;
}

function fill(s: ToyServer): void {
  while (s.running.length < CAP && s.waitHead < s.waiting.length) {
    s.running.push(s.waiting[s.waitHead++]!);
  }
}

/** Recomputes the next completion after any change: cancel the old event, schedule the new one. */
function replan(state: DayState, ctx: Ctx): void {
  const s = state.e2server;
  if (ctx.cancel(s.doneEv)) s.cancelled.push(s.doneEv);
  s.doneEv = NO_EVENT;
  const n = s.running.length;
  if (n > 0) {
    let best = s.running[0]!;
    for (const j of s.running) if (s.remaining[j]! < s.remaining[best]!) best = j;
    // Clamp: float error can leave a hair of negative work; never schedule in the past.
    s.doneEv = ctx.schedule(ctx.nowMs + Math.max(0, s.remaining[best]!) * n, K_DONE, best);
  }
  setLevel(s.inSystem, ctx.nowMs, n + s.waiting.length - s.waitHead);
  setLevel(s.busy, ctx.nowMs, n > 0 ? 1 : 0);
}

function serverSubmit(state: DayState, ctx: Ctx, job: number, workMs: number): void {
  const s = state.e2server;
  accrue(s, ctx.nowMs);
  s.remaining[job] = workMs;
  s.waiting.push(job);
  fill(s);
  replan(state, ctx);
}

function serverAbort(state: DayState, ctx: Ctx, job: number): void {
  const s = state.e2server;
  accrue(s, ctx.nowMs);
  const r = s.running.indexOf(job);
  if (r >= 0) s.running.splice(r, 1);
  else s.waiting.splice(s.waiting.indexOf(job, s.waitHead), 1);
  s.remaining[job] = 0;
  fill(s);
  replan(state, ctx);
}

const toyServer = defineModule({
  name: 'e2server',
  init: (_state, ctx) => ({
    running: [],
    waiting: [],
    waitHead: 0,
    remaining: [],
    lastMs: ctx.nowMs,
    doneEv: NO_EVENT,
    cancelled: [],
    inSystem: createLevel(ctx.nowMs),
    busy: createLevel(ctx.nowMs),
  }),
  events: [
    {
      kind: K_DONE,
      name: 'toy.done',
      priority: PRIORITY.engine,
      handle(state, ev, ctx) {
        const s = state.e2server;
        const job = ev.a;
        check(ctx.nowMs === ev.atMs, 'ctx.nowMs differs from the event time');
        check(s.doneEv === ev.handle && s.running.includes(job), `stale completion for ${job}`);
        s.doneEv = NO_EVENT;
        accrue(s, ctx.nowMs);
        check(Math.abs(s.remaining[job]!) < 1e-6, `job ${job} done with work ${s.remaining[job]}`);
        s.running.splice(s.running.indexOf(job), 1);
        s.remaining[job] = 0;
        fill(s);
        replan(state, ctx);
        ctx.notify(T_DONE, job);
      },
    },
  ],
  onInjected(state, event, ctx) {
    if (event.type !== 'crash') return;
    const s = state.e2server;
    accrue(s, ctx.nowMs);
    const failed = [...s.running, ...s.waiting.slice(s.waitHead)];
    s.running.length = 0;
    s.waiting.length = 0;
    s.waitHead = 0;
    for (const j of failed) s.remaining[j] = 0;
    replan(state, ctx);
    for (const j of failed) ctx.notify(T_FAILED, j);
  },
  assertInvariants(state) {
    const s = state.e2server;
    check(s.running.length <= CAP, 'over the concurrency cap');
    check(s.running.length > 0 === (s.doneEv !== NO_EVENT), 'completion event out of sync');
    const inSystem = s.running.length + s.waiting.length - s.waitHead;
    check(s.inSystem.value === inSystem, 'inSystem level out of sync');
    const pending = state.e2load.outcome.filter((o) => o === 0).length;
    check(pending === inSystem, `load has ${pending} pending jobs, server holds ${inSystem}`);
  },
});

// Load and client.

function newJob(state: DayState, ctx: Ctx, workMs: number, code: number): void {
  const l = state.e2load;
  const job = l.arriveMs.length;
  const timeout = state.core.params.timeoutToFirstTokenMs;
  l.arriveMs.push(ctx.nowMs);
  l.deadlineMs.push(timeout === null ? Infinity : ctx.nowMs + timeout);
  l.outcome.push(0);
  l.timeoutEv.push(timeout === null ? NO_EVENT : ctx.schedule(ctx.nowMs + timeout, K_TIMEOUT, job));
  l.log.push(ctx.nowMs, code, job);
  serverSubmit(state, ctx, job, workMs);
}

function scheduleNextArrival(state: DayState, ctx: Ctx, fromMs: number): void {
  const gap =
    (-Math.log(u01(ctx.input.config.seed, 1, state.e2load.organic)) * MEAN_GAP_MS) /
    state.core.params.loadMultiplier;
  if (fromMs + gap < ctx.dayStartMs + WINDOW_END) ctx.schedule(fromMs + gap, K_ARRIVE);
}

function onJobEnded(state: DayState, topic: number, job: number, ctx: Ctx): void {
  const l = state.e2load;
  check(l.outcome[job] === 0, `job ${job} ended twice`);
  const h = l.timeoutEv[job]!;
  if (ctx.cancel(h)) l.cancelled.push(h);
  l.timeoutEv[job] = NO_EVENT;
  const code = topic === T_DONE ? LOG.done : LOG.failed;
  l.outcome[job] = code;
  l.log.push(ctx.nowMs, code, job);
}

const toyLoad = defineModule({
  name: 'e2load',
  init(state, ctx) {
    const slice: ToyLoad = {
      organic: 0,
      arriveMs: [],
      deadlineMs: [],
      outcome: [],
      timeoutEv: [],
      cancelled: [],
      paramsSeen: [],
      log: [],
    };
    // The slice isn't attached until init returns, so read params from core and schedule directly.
    const gap =
      (-Math.log(u01(ctx.input.config.seed, 1, 0)) * MEAN_GAP_MS) /
      state.core.params.loadMultiplier;
    ctx.schedule(ctx.dayStartMs + WINDOW_START + gap, K_ARRIVE);
    return slice;
  },
  events: [
    {
      kind: K_ARRIVE,
      name: 'toy.arrive',
      priority: PRIORITY.arrival,
      handle(state, ev, ctx) {
        check(ctx.nowMs === ev.atMs, 'ctx.nowMs differs from the event time');
        const l = state.e2load;
        const i = ++l.organic;
        newJob(state, ctx, -Math.log(u01(ctx.input.config.seed, 2, i)) * MEAN_WORK_MS, LOG.arrive);
        scheduleNextArrival(state, ctx, ctx.nowMs);
      },
    },
    {
      kind: K_TIMEOUT,
      name: 'toy.timeout',
      priority: PRIORITY.client,
      handle(state, ev, ctx) {
        const l = state.e2load;
        const job = ev.a;
        check(l.outcome[job] === 0 && l.timeoutEv[job] === ev.handle, `stale timeout for ${job}`);
        check(ev.atMs === l.deadlineMs[job], 'timeout fired off its deadline');
        l.outcome[job] = LOG.timeout;
        l.timeoutEv[job] = NO_EVENT;
        l.log.push(ctx.nowMs, LOG.timeout, job);
        serverAbort(state, ctx, job);
      },
    },
  ],
  notices: [
    { topic: T_DONE, handle: (state, n, ctx) => onJobEnded(state, n.topic, n.a, ctx) },
    { topic: T_FAILED, handle: (state, n, ctx) => onJobEnded(state, n.topic, n.a, ctx) },
  ],
  onParams(state, _changes, ctx) {
    const p = state.core.params;
    state.e2load.paramsSeen.push(ctx.nowMs, p.loadMultiplier, p.timeoutToFirstTokenMs ?? -1);
  },
  onInjected(state, event, ctx) {
    if (event.type === 'extraRequest') newJob(state, ctx, event.promptTokens, LOG.extra);
  },
  assertInvariants(state, ctx) {
    const l = state.e2load;
    for (let j = 0; j < l.outcome.length; j++) {
      const pending = l.outcome[j] === 0 && l.deadlineMs[j] !== Infinity;
      check(ctx.isPending(l.timeoutEv[j]!) === pending, `timeout handle of job ${j} out of sync`);
    }
  },
});

// Meter: E9's role in miniature. Integrates levels at bucket ends and produces the chunk.

const toyMeter = defineModule({
  name: 'e2meter',
  init: () => ({ meanInSystem: [], busyMs: [], finished: [], finishedOpen: 0 }),
  notices: [
    {
      topic: T_DONE,
      handle(state) {
        state.e2meter.finishedOpen++;
      },
    },
  ],
  onBucketEnd(state, boundaryMs, ctx) {
    const s = state.e2server;
    const m = state.e2meter;
    check(ctx.nowMs === boundaryMs, 'bucket hook off its boundary');
    m.meanInSystem.push(takeLevelMean(s.inSystem, boundaryMs));
    m.busyMs.push(takeLevelMean(s.busy, boundaryMs) * ctx.input.config.bucketMs);
    m.finished.push(m.finishedOpen);
    m.finishedOpen = 0;
  },
  produceChunk(state, span, ctx) {
    const chunk = emptyChunk(ctx.input, span);
    const m = state.e2meter;
    const sc = chunk.scalars;
    const first = (span.bucketsFromMs - ctx.dayStartMs) / sc.bucketMs;
    for (let i = 0; i < sc.count; i++) {
      sc.data.running[i * sc.series] = m.meanInSystem[first + i]!;
      sc.data.busyMs[i * sc.series] = m.busyMs[first + i]!;
      sc.data.finished[i * sc.series] = m.finished[first + i]!;
    }
    return chunk;
  },
});

const MODULES: readonly EngineModule[] = [toyLoad, toyServer, toyMeter];

// ---------------------------------------------------------------------------------------------
// Harness

const DAY: DayIndex = 2;
const START = dayStartMs(DAY);
const END = START + DAY_MS;
const BUCKET_MS = 10_000;

function config(seed: number): SimConfig {
  return {
    seed,
    replicas: 1,
    analystsPerReplica: 1,
    shift: { startMs: 7 * HOUR_MS, endMs: 19 * HOUR_MS },
    diurnal: { knots: [[0, 1]], dayMultipliers: [1, 1, 1, 1, 1] },
    sessionsPerAnalystPerDay: 1,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 2,
    virtualNodesPerReplica: 16,
    routerOverheadMs: 2,
    detectionDelayMs: 10_000,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: BUCKET_MS,
    histBucketMs: 60_000,
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

// The core only fingerprints calibration, so a stand-in object is enough here.
const CALIBRATION = { schemaVersion: 1, status: 'provisional' } as unknown as Calibration;

function input(patches: Patch[] = [], seed = 7, day: DayIndex = DAY): DayRunInput {
  return {
    config: config(seed),
    calibration: CALIBRATION,
    day,
    patches,
    trackedAnalyst: null,
    detail: 'tracked',
  };
}

/** A runner whose trace records [atMs, kind, a, b, handle] for every dispatch. */
function traced(options: { assertEveryEvent?: boolean } = {}) {
  const log: number[] = [];
  const runner = createDayRunner(MODULES, {
    ...options,
    trace: (ev) => {
      log.push(ev.atMs, ev.kind, ev.a, ev.b, ev.handle);
    },
  });
  return { runner, log };
}

/** Scalar series from chunks, checking they tile whole buckets without gaps. */
function seriesOf(chunks: readonly ResultChunk[]) {
  const out = { running: [] as number[], busyMs: [] as number[], finished: [] as number[] };
  let nextStart = START;
  for (const c of chunks) {
    const s = c.scalars;
    expect(s.startMs).toBe(nextStart);
    for (let i = 0; i < s.count; i++) {
      out.running.push(s.data.running[i * s.series]!);
      out.busyMs.push(s.data.busyMs[i * s.series]!);
      out.finished.push(s.data.finished[i * s.series]!);
    }
    nextStart = s.startMs + s.count * s.bucketMs;
  }
  return out;
}

function fullRun(patches: Patch[] = [], seed = 7) {
  const { runner, log } = traced();
  const run = runner.createDayRun(input(patches, seed));
  const chunks = [run.advance(END)];
  return { run, log, chunks, digest: digestState(run.state) };
}

const reference = fullRun();

// ---------------------------------------------------------------------------------------------

describe('toy model on the day runner', () => {
  it('does real work: thousands of events, many cancellations, some timeouts', () => {
    const l = reference.run.state.e2load;
    if (process.env.CORE_BENCH) {
      console.info('toy stats', {
        events: reference.log.length / 5,
        jobs: l.arriveMs.length,
        done: l.outcome.filter((o) => o === LOG.done).length,
        timeouts: l.outcome.filter((o) => o === LOG.timeout).length,
        cancelled: l.cancelled.length + reference.run.state.e2server.cancelled.length,
      });
    }
    expect(reference.log.length / 5).toBeGreaterThan(9_000);
    expect(l.arriveMs.length).toBeGreaterThan(4_000);
    expect(l.outcome.filter((o) => o === LOG.timeout).length).toBeGreaterThan(100);
    expect(l.outcome.filter((o) => o === LOG.done).length).toBeGreaterThan(4_000);
    expect(l.cancelled.length + reference.run.state.e2server.cancelled.length).toBeGreaterThan(
      5_000,
    );
    expect(reference.run.done).toBe(true);
    expect(reference.run.nowMs).toBe(END);
  });

  it('is deterministic, and the seed matters', () => {
    const again = fullRun();
    expect(again.log).toEqual(reference.log);
    expect(again.digest).toBe(reference.digest);
    expect(seriesOf(again.chunks)).toEqual(seriesOf(reference.chunks));
    expect(fullRun([], 8).digest).not.toBe(reference.digest);
  });

  it('never moves time backwards; handlers run at their event time', () => {
    for (let i = 5; i < reference.log.length; i += 5) {
      expect(reference.log[i]!).toBeGreaterThanOrEqual(reference.log[i - 5]!);
    }
  });

  it('never fires an invalidated event', () => {
    const dispatched = new Set<number>();
    for (let i = 0; i < reference.log.length; i += 5) {
      if (reference.log[i + 1] !== PATCH_KIND) dispatched.add(reference.log[i + 4]!);
    }
    const cancelled = [
      ...reference.run.state.e2load.cancelled,
      ...reference.run.state.e2server.cancelled,
    ];
    expect(cancelled.length).toBeGreaterThan(5_000);
    for (const h of cancelled) expect(dispatched.has(h)).toBe(false);
  });

  it('keeps invariants after every event, and state stays plain data', () => {
    const { runner } = traced({ assertEveryEvent: true });
    const run = runner.createDayRun(input());
    for (const t of [START + 9 * HOUR_MS, START + 9.5 * HOUR_MS + 0.5, START + 10 * HOUR_MS]) {
      run.advance(t);
      run.assertInvariants();
      expect(structuredClone(run.state)).toEqual(run.state);
    }
  });

  it('checkpoint, restore, advance equals an uninterrupted run', () => {
    const firstEventAt = reference.log[5 * 1000]!; // an instant with an event exactly on it
    const cuts = [
      START,
      START + 9 * HOUR_MS, // bucket boundary
      START + 9 * HOUR_MS + 1234.5,
      firstEventAt,
      START + 10 * HOUR_MS + 7,
      END - 1,
      END,
    ];
    for (const cut of cuts) {
      const a = traced();
      const runA = a.runner.createDayRun(input());
      const chunksA = [runA.advance(cut)];
      const cp = runA.checkpoint();
      expect(cp.atMs).toBe(cut);
      const before = digestState(cp.state);
      // Restore twice: a checkpoint is never mutated by the runs made from it.
      for (let k = 0; k < 2; k++) {
        const b = traced();
        const runB = b.runner.restoreDayRun(input(), cp);
        expect(digestState(runB.state)).toBe(before);
        const chunksB = [runB.advance(END)];
        expect([...a.log, ...b.log]).toEqual(reference.log);
        expect(digestState(runB.state)).toBe(reference.digest);
        expect(seriesOf([...chunksA, ...chunksB])).toEqual(seriesOf(reference.chunks));
      }
      expect(digestState(cp.state)).toBe(before);
    }
  });

  it('advancing in many small steps equals one big step', () => {
    const { runner, log } = traced();
    const run = runner.createDayRun(input());
    const chunks: ResultChunk[] = [];
    let seed = 1;
    let prevTo = START;
    while (!run.done) {
      seed = mix32(seed);
      const r = seed / 4294967296;
      // Mix zero-length steps, sub-millisecond steps, bucket-aligned steps, and big jumps.
      const next =
        r < 0.1
          ? run.nowMs
          : r < 0.4
            ? run.nowMs + r * 3
            : r < 0.7
              ? (Math.floor(run.nowMs / BUCKET_MS) + 1) * BUCKET_MS
              : run.nowMs + r * 20 * MINUTE_MS;
      const c = run.advance(next);
      expect(c.fromMs).toBe(prevTo);
      prevTo = c.toMs;
      chunks.push(c);
    }
    expect(chunks.length).toBeGreaterThan(200);
    expect(log).toEqual(reference.log);
    expect(digestState(run.state)).toBe(reference.digest);
    expect(seriesOf(chunks)).toEqual(seriesOf(reference.chunks));
    expect(seriesOf(advanceInSteps(runner.createDayRun(input()), END, 60_000))).toEqual(
      seriesOf(reference.chunks),
    );
  });

  it('round-trips state through structuredClone at any point', () => {
    const { runner } = traced();
    const run = runner.createDayRun(input());
    run.advance(START + 9.25 * HOUR_MS);
    const clone = structuredClone(run.state);
    expect(clone).toEqual(run.state);
    assertPlainData(clone);
    expect(digestState(clone)).toBe(digestState(run.state));
  });
});

describe('patches on the toy model', () => {
  const T1 = START + 9.5 * HOUR_MS + 333.25;
  const setTimeout3s: Patch = { kind: 'set', atMs: T1, changes: { timeoutToFirstTokenMs: 3_000 } };

  it("applies 'set' patches dated before the day at its start, not as events", () => {
    const pre: Patch = {
      kind: 'set',
      atMs: dayStartMs(1) + 12 * HOUR_MS,
      changes: { timeoutToFirstTokenMs: 5_000 },
    };
    const run = createDayRunner(MODULES).createDayRun(input([pre]));
    expect(run.state.core.params.timeoutToFirstTokenMs).toBe(5_000);
    run.advance(END);
    const l = run.state.e2load;
    expect(l.paramsSeen).toEqual([]);
    expect(l.deadlineMs[0]! - l.arriveMs[0]!).toBe(5_000);
  });

  it('ignores event patches from other days and set patches from later days', () => {
    const others: Patch[] = [
      { kind: 'set', atMs: dayStartMs(3) + HOUR_MS, changes: { timeoutToFirstTokenMs: 1 } },
      { kind: 'event', atMs: dayStartMs(1) + 10 * HOUR_MS, event: extra(99_999) },
      { kind: 'event', atMs: dayStartMs(3) + 10 * HOUR_MS, event: extra(99_999) },
      { kind: 'event', atMs: END, event: extra(99_999) },
    ];
    const r = fullRun(others);
    expect(r.run.state.core.patches).toEqual({ preDay: [], inDay: [], next: 0 });
    expect(r.log).toEqual(reference.log);
    expect(r.digest).toBe(reference.digest);
  });

  it("applies an in-day 'set' patch exactly at its time", () => {
    const run = createDayRunner(MODULES).createDayRun(input([setTimeout3s]));
    run.advance(T1);
    expect(run.state.e2load.paramsSeen).toEqual([]); // events at exactly untilMs wait
    run.advance(END);
    expect(run.state.e2load.paramsSeen).toEqual([T1, 1, 3_000]);
    const l = run.state.e2load;
    let before = 0;
    let after = 0;
    for (let j = 0; j < l.arriveMs.length; j++) {
      const timeout = l.deadlineMs[j]! - l.arriveMs[j]!;
      if (l.arriveMs[j]! < T1) {
        expect(timeout).toBe(12_000);
        before++;
      } else {
        expect(timeout).toBe(3_000);
        after++;
      }
    }
    expect(before).toBeGreaterThan(100);
    expect(after).toBeGreaterThan(100);
  });

  it('dispatches event patches at their time, before any event at that instant', () => {
    // Put the patch exactly on an event time of the reference run.
    const at = reference.log[5 * 3000]!;
    const r = fullRun([{ kind: 'event', atMs: at, event: extra(4_000) }]);
    const i = r.log.findIndex((x, k) => k % 5 === 0 && x === at);
    expect(r.log[i + 1]).toBe(PATCH_KIND);
    const l = r.run.state.e2load;
    const k = l.log.findIndex((x, n) => n % 3 === 1 && x === LOG.extra);
    expect(l.log[k - 1]).toBe(at);
  });

  it('applies patches with the same time in input order', () => {
    const a: Patch = { kind: 'set', atMs: T1, changes: { loadMultiplier: 2 } };
    const b: Patch = { kind: 'set', atMs: T1, changes: { loadMultiplier: 0.5 } };
    const run = createDayRunner(MODULES).createDayRun(input([b, setTimeout3s, a]));
    run.advance(END);
    expect(run.state.core.params.loadMultiplier).toBe(2);
    expect(run.state.e2load.paramsSeen).toEqual([T1, 0.5, 12_000, T1, 0.5, 3_000, T1, 2, 3_000]);
  });

  it('a crash event fails in-flight work and cancels its pending events', () => {
    const at = START + 10 * HOUR_MS + 0.5;
    const r = fullRun([{ kind: 'event', atMs: at, event: { type: 'crash', replica: 0 } }]);
    const l = r.run.state.e2load;
    const failed = l.outcome.filter((o) => o === LOG.failed).length;
    expect(failed).toBeGreaterThan(0);
    for (let n = 0; n < l.log.length; n += 3) {
      if (l.log[n + 1] === LOG.failed) expect(l.log[n]).toBe(at);
    }
    r.run.assertInvariants();
  });
});

describe('forks: restore with different patches', () => {
  const C = START + 9.5 * HOUR_MS; // a histogram-bucket cut
  const P: Patch = { kind: 'set', atMs: C + 12_345, changes: { timeoutToFirstTokenMs: 3_000 } };
  const E: Patch = { kind: 'event', atMs: C + 20 * MINUTE_MS, event: extra(9_000) };
  const Q: Patch = { kind: 'set', atMs: C + HOUR_MS, changes: { loadMultiplier: 1.4 } };

  function fork(basePatches: Patch[], cutMs: number, newPatches: Patch[]) {
    const a = traced();
    const runA = a.runner.createDayRun(input(basePatches));
    runA.advance(cutMs);
    const cp = runA.checkpoint();
    const b = traced();
    const runB = b.runner.restoreDayRun(input(newPatches), cp);
    runB.advance(END);
    return { log: [...a.log, ...b.log], digest: digestState(runB.state), run: runB };
  }

  it('adding patches after the checkpoint equals a fresh run with them', () => {
    const fresh = fullRun([P, E]);
    const forked = fork([], C, [E, P]);
    expect(forked.log).toEqual(fresh.log);
    expect(forked.digest).toBe(fresh.digest);
    expect(fresh.digest).not.toBe(reference.digest);
  });

  it('removing or replacing a pending patch equals a fresh run without it', () => {
    const fresh = fullRun([P]);
    expect(fork([P, Q], C, [P]).digest).toBe(fresh.digest);
    const q2: Patch = { kind: 'set', atMs: C, changes: { loadMultiplier: 0.7 } };
    const q1: Patch = { kind: 'set', atMs: C, changes: { loadMultiplier: 1.6 } };
    // A patch dated exactly at the checkpoint has not been applied yet, so it may change too.
    expect(fork([q1], C, [q2]).digest).toBe(fullRun([q2]).digest);
  });

  it('keeps patches applied before the checkpoint, and rejects a different history', () => {
    const early: Patch = { ...P, atMs: C - 1 };
    const forked = fork([early], C, [early, E]);
    expect(forked.digest).toBe(fullRun([early, E]).digest);

    const base = createDayRunner(MODULES).createDayRun(input([early]));
    base.advance(C);
    const cp = base.checkpoint();
    const runner = createDayRunner(MODULES);
    expect(() => runner.restoreDayRun(input([]), cp)).toThrow(/before the checkpoint/);
    const moved: Patch = { ...early, atMs: C - 2 };
    expect(() => runner.restoreDayRun(input([moved]), cp)).toThrow(/before the checkpoint/);
    const pre: Patch = { kind: 'set', atMs: 0, changes: { maxRetries: 2 } };
    expect(() => runner.restoreDayRun(input([pre, early]), cp)).toThrow(/before the day/);
    expect(() => runner.restoreDayRun(input([early], 8), cp)).toThrow(/config or calibration/);
    expect(() => runner.restoreDayRun(input([early], 7, 3), cp)).toThrow(/day 2, not 3/);
    expect(() => createDayRunner([toyLoad, toyServer]).restoreDayRun(input([early]), cp)).toThrow(
      /slices/,
    );
    // Detail and tracking may change on restore (detail re-simulation, K7).
    const detailed = { ...input([early]), detail: 'all' as const, trackedAnalyst: 3 };
    expect(() => runner.restoreDayRun(detailed, cp)).not.toThrow();
  });
});

function extra(promptTokens: number) {
  return {
    type: 'extraRequest' as const,
    analyst: 'tracked' as const,
    promptTokens,
    outputTokens: 1,
  };
}
