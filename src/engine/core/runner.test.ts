// Targeted tests of the runner's rules, using a scriptable probe module. The toy model in
// toy-model.test.ts covers the end-to-end properties (determinism, checkpoints, forks).

import { describe, expect, it } from 'vitest';
import type { DayRunInput, Patch, SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { HISTOGRAM_SPECS } from '../histogram.ts';
import { DAY_MS, HOUR_MS, dayStartMs, type DayIndex } from '../time.ts';
import { PRIORITY, TOPIC } from './ids.ts';
import { NO_EVENT } from './queue.ts';
import { createDayRunner } from './runner.ts';
import { defineModule, type Ctx, type DayState, type EngineModule } from './types.ts';

interface ProbeSlice {
  /** Flat [code, nowMs, a, b]. */
  calls: number[];
  handles: number[];
}

declare module './types.ts' {
  interface DayState {
    e2probe: ProbeSlice;
    e2probe2: ProbeSlice;
  }
}

const DAY: DayIndex = 1;
const START = dayStartMs(DAY);
const END = START + DAY_MS;
const BUCKET_MS = 10_000;
const HIST_MS = 60_000;

const K_LOW = 960; // priority 10
const K_HIGH = 961; // priority 50
const K_CHAIN = 962; // schedules K_LOW at now
const K_THROW = 963;
const K_NOTIFY = 964;
const T_PING = 970;
const T_NESTED = 971;

const CODE = { low: 1, high: 2, chain: 3, bucket: 4, params: 5, injected: 6, ping: 7, nested: 8 };

type Plan = readonly (readonly [atMs: number, kind: number, a?: number])[];

function log(state: DayState, code: number, ctx: Ctx, a = 0, b = 0): void {
  state.e2probe.calls.push(code, ctx.nowMs, a, b);
}

/** A module that schedules `plan` at init and logs everything it sees. */
function probe(plan: Plan = [], opts: { bucketSchedule?: boolean } = {}) {
  return defineModule({
    name: 'e2probe',
    init(_state, ctx) {
      const handles = plan.map(([at, kind, a]) => ctx.schedule(at, kind, a ?? 0));
      return { calls: [], handles };
    },
    events: [
      {
        kind: K_LOW,
        name: 'probe.low',
        priority: 10,
        handle: (s, ev, ctx) => log(s, CODE.low, ctx, ev.a),
      },
      {
        kind: K_HIGH,
        name: 'probe.high',
        priority: 50,
        handle: (s, ev, ctx) => log(s, CODE.high, ctx, ev.a),
      },
      {
        kind: K_CHAIN,
        name: 'probe.chain',
        priority: 30,
        handle(s, ev, ctx) {
          log(s, CODE.chain, ctx, ev.a);
          ctx.schedule(ctx.nowMs, K_LOW, ev.a + 1);
        },
      },
      {
        kind: K_THROW,
        name: 'probe.throw',
        priority: PRIORITY.late,
        handle() {
          throw new Error('probe handler failed');
        },
      },
      {
        kind: K_NOTIFY,
        name: 'probe.notify',
        priority: PRIORITY.late,
        handle: (_s, ev, ctx) => ctx.notify(T_PING, ev.a, 7),
      },
    ],
    notices: [
      {
        topic: T_PING,
        handle(s, n, ctx) {
          log(s, CODE.ping, ctx, n.a, n.b);
          ctx.notify(T_NESTED, n.a + 100);
          // The outer notice view is intact after a nested notify.
          log(s, CODE.ping, ctx, n.a, n.b);
        },
      },
    ],
    onBucketEnd(s, boundaryMs, ctx) {
      log(s, CODE.bucket, ctx, boundaryMs);
      if (opts.bucketSchedule) ctx.schedule(boundaryMs, K_HIGH, -1);
    },
    onParams: (s, changes, ctx) => log(s, CODE.params, ctx, changes.loadMultiplier ?? NaN),
    onInjected: (s, event, ctx) => log(s, CODE.injected, ctx, event.type === 'crash' ? 1 : 2),
  });
}

/** A second module that listens to the same topic, to check subscriber order. */
const listener = defineModule({
  name: 'e2probe2',
  init: () => ({ calls: [], handles: [] }),
  notices: [
    {
      topic: T_PING,
      handle: (s, n, ctx) =>
        s.e2probe2.calls.push(CODE.ping, ctx.nowMs, n.a, s.e2probe.calls.length),
    },
    {
      topic: T_NESTED,
      handle: (s, n, ctx) => s.e2probe2.calls.push(CODE.nested, ctx.nowMs, n.a, 0),
    },
  ],
});

function config(): SimConfig {
  return {
    seed: 1,
    replicas: 3,
    analystsPerReplica: 1,
    shift: { startMs: 0, endMs: DAY_MS },
    diurnal: { knots: [[0, 1]], dayMultipliers: [1, 1, 1, 1, 1] },
    sessionsPerAnalystPerDay: 1,
    messageTokensSigma: 1,
    outputTokensSigma: 1,
    outputTokensMax: 1,
    thinkTimeShape: 1,
    virtualNodesPerReplica: 1,
    routerOverheadMs: 0,
    detectionDelayMs: 0,
    coldStart: 'replacementHost',
    engineOverrides: {},
    bucketMs: BUCKET_MS,
    histBucketMs: HIST_MS,
    tunable: {
      loadMultiplier: 1,
      systemPromptTokens: 1,
      turnsPerSessionMean: 1,
      messageTokensMedian: 1,
      outputTokensMedian: 1,
      thinkTimeMedianMs: 1,
      timeoutToFirstTokenMs: null,
      retryPolicy: 'none',
      retryBaseMs: 1,
      retryCapMs: 1,
      maxRetries: 0,
      routingPolicy: 'roundRobin',
      hashScheme: 'modN',
      signalRefreshMs: 1,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

function input(patches: Patch[] = [], cfg: Partial<SimConfig> = {}): DayRunInput {
  return {
    config: { ...config(), ...cfg },
    calibration: { schemaVersion: 1 } as unknown as Calibration,
    day: DAY,
    patches,
    trackedAnalyst: null,
    detail: 'tracked',
  };
}

function start(plan: Plan, patches: Patch[] = [], modules?: readonly EngineModule[]) {
  return createDayRunner(modules ?? [probe(plan)]).createDayRun(input(patches));
}

/** Calls as [code, nowMs, a] triples, optionally without bucket hooks. */
function calls(state: DayState, withBuckets = false): number[][] {
  const out: number[][] = [];
  const c = state.e2probe.calls;
  for (let i = 0; i < c.length; i += 4) {
    if (withBuckets || c[i] !== CODE.bucket) out.push([c[i]!, c[i + 1]!, c[i + 2]!]);
  }
  return out;
}

describe('advance boundary rule', () => {
  it('runs events before untilMs; events exactly at untilMs wait for the next advance', () => {
    const run = start([
      [START + 100, K_LOW, 1],
      [START + 200, K_LOW, 2],
    ]);
    run.advance(START + 200);
    expect(calls(run.state)).toEqual([[CODE.low, START + 100, 1]]);
    expect(run.nowMs).toBe(START + 200);
    run.advance(START + 200); // zero-length: still waits
    expect(calls(run.state)).toHaveLength(1);
    run.advance(START + 200.001);
    expect(calls(run.state)).toEqual([
      [CODE.low, START + 100, 1],
      [CODE.low, START + 200, 2],
    ]);
  });

  it('clamps to the day end, where nothing runs, and reports done', () => {
    const run = start([
      [END - 0.5, K_LOW, 1],
      [END, K_LOW, 2],
      [END + 5, K_LOW, 3],
    ]);
    expect(run.state.e2probe.handles.slice(1)).toEqual([NO_EVENT, NO_EVENT]);
    expect(run.done).toBe(false);
    const chunk = run.advance(END + 10 * DAY_MS);
    expect(run.nowMs).toBe(END);
    expect(run.done).toBe(true);
    expect(chunk.toMs).toBe(END);
    expect(calls(run.state)).toEqual([[CODE.low, END - 0.5, 1]]);
    const after = run.advance(END + 1);
    expect([after.fromMs, after.toMs, after.scalars.count]).toEqual([END, END, 0]);
  });

  it('rejects moving backwards and NaN', () => {
    const run = start([]);
    run.advance(START + 1000);
    expect(() => run.advance(START + 999)).toThrow(RangeError);
    expect(() => createDayRunner([probe()]).createDayRun(input()).advance(NaN)).toThrow(RangeError);
  });

  it('orders ties by priority, then insertion; same-instant follow-ups run in the same advance', () => {
    const t = START + 500;
    const run = start([
      [t, K_HIGH, 1],
      [t, K_LOW, 2],
      [t, K_CHAIN, 10],
      [t, K_HIGH, 3],
      [t, K_LOW, 4],
    ]);
    run.advance(t + 1);
    expect(calls(run.state).map((c) => c[2])).toEqual([2, 4, 10, 11, 1, 3]);
  });
});

describe('bucket hooks', () => {
  it('close each boundary once, in order, after events before it and before events at it', () => {
    const b1 = START + BUCKET_MS;
    const run = start([
      [b1 - 1, K_HIGH, 1],
      [b1, K_LOW, 2],
      [b1 + 3 * BUCKET_MS + 5, K_LOW, 3],
    ]);
    run.advance(b1); // closes b1 at the end of this advance
    run.advance(b1 + 2 * BUCKET_MS + 1);
    run.advance(b1 + 4 * BUCKET_MS);
    expect(calls(run.state, true)).toEqual([
      [CODE.high, b1 - 1, 1],
      [CODE.bucket, b1, b1],
      [CODE.low, b1, 2],
      [CODE.bucket, b1 + BUCKET_MS, b1 + BUCKET_MS],
      [CODE.bucket, b1 + 2 * BUCKET_MS, b1 + 2 * BUCKET_MS],
      [CODE.bucket, b1 + 3 * BUCKET_MS, b1 + 3 * BUCKET_MS],
      [CODE.low, b1 + 3 * BUCKET_MS + 5, 3],
      [CODE.bucket, b1 + 4 * BUCKET_MS, b1 + 4 * BUCKET_MS],
    ]);
    run.advance(END);
    const buckets = calls(run.state, true).filter((c) => c[0] === CODE.bucket);
    expect(buckets).toHaveLength(DAY_MS / BUCKET_MS);
    expect(buckets.at(-1)![1]).toBe(END);
  });

  it('may schedule at the boundary; the event runs before later ones', () => {
    const b1 = START + BUCKET_MS;
    const run = createDayRunner([
      probe([[b1 + 1, K_LOW, 5]], { bucketSchedule: true }),
    ]).createDayRun(input());
    run.advance(b1 + 2);
    expect(calls(run.state, true)).toEqual([
      [CODE.bucket, b1, b1],
      [CODE.high, b1, -1],
      [CODE.low, b1 + 1, 5],
    ]);
  });

  it('closes a boundary before a patch dated exactly on it', () => {
    const b1 = START + BUCKET_MS;
    const run = start([], [{ kind: 'set', atMs: b1, changes: { loadMultiplier: 3 } }]);
    run.advance(b1 + 1);
    expect(calls(run.state, true)).toEqual([
      [CODE.bucket, b1, b1],
      [CODE.params, b1, 3],
    ]);
  });
});

describe('stub chunk producer', () => {
  it('emits zero-filled blocks for exactly the buckets completed, and no records', () => {
    const run = start([]);
    const c1 = run.advance(START + 95_000);
    expect([c1.day, c1.fromMs, c1.toMs, c1.replicas]).toEqual([DAY, START, START + 95_000, 3]);
    expect([c1.scalars.startMs, c1.scalars.count, c1.scalars.series]).toEqual([START, 9, 4]);
    expect(c1.scalars.data.kvUsedFrac).toHaveLength(9 * 4);
    expect([c1.histograms.startMs, c1.histograms.count]).toEqual([START, 1]);
    expect(c1.histograms.data.ttft).toHaveLength(1 * 4 * HISTOGRAM_SPECS.ttft.bins);
    expect([c1.requests.scope, c1.requests.count, c1.transitions.count]).toEqual(['tracked', 0, 0]);
    expect(c1.replicaEvents).toEqual([]);
    const c2 = run.advance(START + 125_000);
    expect([c2.scalars.startMs, c2.scalars.count]).toEqual([START + 90_000, 3]);
    expect([c2.histograms.startMs, c2.histograms.count]).toEqual([START + 60_000, 1]);
    const c3 = run.advance(END);
    expect(c3.scalars.startMs + c3.scalars.count * BUCKET_MS).toBe(END);
    expect(c3.histograms.startMs + c3.histograms.count * HIST_MS).toBe(END);
  });
});

describe('ctx services', () => {
  it('cancels, reschedules, and reports pending events', () => {
    let ctxSeen: Ctx | undefined;
    const m = defineModule({
      name: 'e2probe',
      init(_s, ctx) {
        ctxSeen = ctx;
        const h1 = ctx.schedule(START + 10, K_LOW, 1);
        const h2 = ctx.schedule(START + 20, K_LOW, 2);
        expect(ctx.isPending(h1)).toBe(true);
        expect(ctx.cancel(h1)).toBe(true);
        expect(ctx.cancel(h1)).toBe(false);
        expect(ctx.isPending(h1)).toBe(false);
        const h3 = ctx.reschedule(h2, START + 30, K_LOW, 3);
        expect(ctx.isPending(h2)).toBe(false);
        return { calls: [], handles: [h3] };
      },
      events: probe().events,
    });
    const run = createDayRunner([m]).createDayRun(input());
    run.advance(START + 100);
    expect(calls(run.state)).toEqual([[CODE.low, START + 30, 3]]);
    expect(ctxSeen!.isPending(run.state.e2probe.handles[0]!)).toBe(false);
    expect(ctxSeen!.cancel(run.state.e2probe.handles[0]!)).toBe(false);
  });

  it('rejects scheduling in the past, unknown kinds, and NaN times', () => {
    const bad = (at: (ctx: Ctx) => number, kind: number) =>
      defineModule({
        name: 'e2probe',
        init(_s, ctx) {
          ctx.schedule(at(ctx), kind);
          return { calls: [], handles: [] };
        },
        events: probe().events,
      });
    const make = (m: EngineModule) => () => createDayRunner([m]).createDayRun(input());
    expect(make(bad((c) => c.nowMs - 1, K_LOW))).toThrow(/before now/);
    expect(make(bad(() => NaN, K_LOW))).toThrow(/before now/);
    expect(make(bad((c) => c.nowMs, 555))).toThrow(/not registered/);
    expect(make(bad((c) => c.nowMs, 1.5))).toThrow(/not registered/);
  });

  it('delivers notices synchronously, in module order, with nesting', () => {
    const t = START + 5;
    const run = createDayRunner([probe([[t, K_NOTIFY, 42]]), listener]).createDayRun(input());
    run.advance(t + 1);
    expect(calls(run.state)).toEqual([
      [CODE.ping, t, 42],
      [CODE.ping, t, 42],
    ]);
    // The listener heard T_PING after the probe's handler had logged twice (it runs second), and the
    // nested topic in between.
    const c2 = run.state.e2probe2.calls;
    expect(c2).toEqual([CODE.nested, t, 142, 0, CODE.ping, t, 42, 8]);
  });

  it('ignores topics nobody listens to, and rejects out-of-range topics', () => {
    const run = createDayRunner([
      defineModule({
        name: 'e2probe',
        init(_s, ctx) {
          ctx.notify(TOPIC.requestEnded, 1, 2);
          expect(() => ctx.notify(0)).toThrow(/out of range/);
          expect(() => ctx.notify(5000)).toThrow(/out of range/);
          return { calls: [], handles: [] };
        },
      }),
    ]).createDayRun(input());
    expect(run.nowMs).toBe(START);
  });
});

describe('patches', () => {
  it("routes 'set' to onParams after updating params, and 'event' to onInjected", () => {
    const t1 = START + 1_000;
    const t2 = START + 2_000;
    const run = start(
      [],
      [
        { kind: 'event', atMs: t2, event: { type: 'crash', replica: 1 } },
        { kind: 'set', atMs: t1, changes: { loadMultiplier: 2 } },
      ],
    );
    expect(run.state.core.params.loadMultiplier).toBe(1);
    run.advance(t2 + 1);
    expect(run.state.core.params.loadMultiplier).toBe(2);
    expect(calls(run.state)).toEqual([
      [CODE.params, t1, 2],
      [CODE.injected, t2, 1],
    ]);
  });

  it("treats a 'set' at the day's first instant as in-day, and one just before it as pre-day", () => {
    const run = start(
      [],
      [
        { kind: 'set', atMs: START - 1, changes: { loadMultiplier: 5 } },
        { kind: 'set', atMs: START, changes: { loadMultiplier: 6 } },
      ],
    );
    expect(run.state.core.params.loadMultiplier).toBe(5);
    run.advance(START + 1);
    expect(calls(run.state)).toEqual([[CODE.params, START, 6]]);
  });

  it('rejects unknown tunable parameters', () => {
    const typo = { kind: 'set', atMs: 0, changes: { loadMultipler: 2 } } as unknown as Patch;
    expect(() => start([], [typo])).toThrow(/unknown tunable parameter 'loadMultipler'/);
  });

  it('ignores undefined values but applies null', () => {
    const run = start(
      [],
      [
        {
          kind: 'set',
          atMs: 0,
          changes: { loadMultiplier: undefined, admissionLimitPerReplica: null },
        },
      ],
    );
    expect(run.state.core.params.loadMultiplier).toBe(1);
    expect(run.state.core.params.admissionLimitPerReplica).toBeNull();
  });
});

describe('runner construction and failure', () => {
  const ev = (kind: number, priority = 10) => ({ kind, name: `k${kind}`, priority, handle() {} });
  const mod = (name: string, extra: Partial<EngineModule> = {}) =>
    ({ name, init: () => ({ calls: [], handles: [] }), ...extra }) as unknown as EngineModule;

  it('validates the module list', () => {
    expect(() => createDayRunner([mod('e2probe'), mod('e2probe')])).toThrow(/Two engine modules/);
    expect(() => createDayRunner([mod('core')])).toThrow(/reserved/);
    expect(() =>
      createDayRunner([
        mod('e2probe', { events: [ev(961)] }),
        mod('e2probe2', { events: [ev(961)] }),
      ]),
    ).toThrow(/taken by k961/);
    expect(() => createDayRunner([mod('e2probe', { events: [ev(0)] })])).toThrow(/not in/);
    expect(() => createDayRunner([mod('e2probe', { events: [ev(1024)] })])).toThrow(/not in/);
    expect(() => createDayRunner([mod('e2probe', { events: [ev(960, -1)] })])).toThrow(/priority/);
    expect(() => createDayRunner([mod('e2probe', { events: [ev(960, 2 ** 20)] })])).toThrow(
      /priority/,
    );
    const produce = () => {
      throw new Error('unused');
    };
    expect(() =>
      createDayRunner([
        mod('e2probe', { produceChunk: produce }),
        mod('e2probe2', { produceChunk: produce }),
      ]),
    ).toThrow(/only one may/);
    expect(() =>
      createDayRunner([mod('e2probe', { notices: [{ topic: 0, handle() {} }] })]),
    ).toThrow(/topic 0/);
  });

  it('validates the day and bucket sizes', () => {
    const runner = createDayRunner([probe()]);
    expect(() => runner.createDayRun({ ...input(), day: 5 as DayIndex })).toThrow(/work-week/);
    expect(() => runner.createDayRun(input([], { bucketMs: 0 }))).toThrow(/bucketMs/);
    expect(() => runner.createDayRun(input([], { bucketMs: 7_000 }))).toThrow(/multiple/);
    expect(() => runner.createDayRun(input([], { bucketMs: 7_000, histBucketMs: 7_000 }))).toThrow(
      /divide a day/,
    );
  });

  it('marks a run unusable after a handler throws', () => {
    const run = start([[START + 5, K_THROW]]);
    expect(() => run.advance(START + 10)).toThrow(/probe handler failed/);
    expect(() => run.advance(START + 20)).toThrow(/threw earlier/);
    expect(() => run.checkpoint()).toThrow(/threw earlier/);
  });

  it('catches non-plain data in state', () => {
    const run = start([]);
    run.assertInvariants();
    (run.state.e2probe as unknown as Record<string, unknown>).fn = () => 1;
    expect(() => run.assertInvariants()).toThrow(/state\.e2probe\.fn is a function/);
  });
});

describe('dispatch throughput', () => {
  // 64 "replicas", each with a next-step event. Each dispatch schedules its own next step and
  // moves another replica's pending step (cancel + schedule, like a batch change). Measures the
  // whole path: peek, take, dispatch, schedule, cancel.
  const K_STEP = 980;
  const N = 64;
  const bench = defineModule({
    name: 'e2probe',
    init(_s, ctx) {
      const handles = [];
      for (let r = 0; r < N; r++) handles.push(ctx.schedule(ctx.nowMs + 1 + r, K_STEP, r));
      return { calls: [0, 1], handles };
    },
    events: [
      {
        kind: K_STEP,
        name: 'bench.step',
        priority: PRIORITY.engine,
        handle(s, ev, ctx) {
          const p = s.e2probe;
          const x = Math.imul(p.calls[1]! ^ (p.calls[1]! >>> 13), 0x5bd1e995) >>> 0 || 1;
          p.calls[1] = x;
          p.calls[0]!++;
          const r = ev.a;
          p.handles[r] = ctx.schedule(ctx.nowMs + 1 + (x % 997), K_STEP, r);
          const other = x % N;
          if (other !== r) {
            const at = ctx.nowMs + 1 + (x % 500);
            p.handles[other] = ctx.reschedule(p.handles[other]!, at, K_STEP, other);
          }
        },
      },
    ],
  });

  it('dispatches well over half a million events per second through the runner', () => {
    const runner = createDayRunner([bench]);
    const measure = (spanMs: number) => {
      const run = runner.createDayRun(input());
      const t0 = process.hrtime.bigint();
      run.advance(START + spanMs);
      const s = Number(process.hrtime.bigint() - t0) / 1e9;
      return { events: run.state.e2probe.calls[0]!, perSec: run.state.e2probe.calls[0]! / s };
    };
    measure(HOUR_MS / 4); // warm up
    const r = measure(HOUR_MS);
    if (process.env.CORE_BENCH) console.info('runner dispatch:', r);
    expect(r.events).toBeGreaterThan(4e5);
    // Loose floor for slow CI; README records measured figures.
    expect(r.perSec).toBeGreaterThan(5e5);
  });
});
