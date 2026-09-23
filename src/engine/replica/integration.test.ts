// The replica between the real router (E7) and metrics (E9), with a stub load module in E6's
// place: module order shared, load, router, replica, metrics (00-build §4).

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import type { RoutingPolicy } from '../api.ts';
import { parseCalibration } from '../calibration.ts';
import {
  PRIORITY,
  TOPIC,
  createDayRunner,
  type Ctx,
  type DayState,
  type EngineModule,
} from '../core/index.ts';
import { metricsModule } from '../metrics/index.ts';
import { OUTCOME, replicaSeries, type ResultChunk } from '../results.ts';
import { routerModule } from '../router/index.ts';
import { REQUEST_KIND, allocRequest, sharedModule } from '../shared/index.ts';
import { harnessInput, testConfig, withEngine } from './harness.ts';
import { createReplicaModule } from './module.ts';
import { randomWorkload } from './workload.ts';

const cal = parseCalibration(raw);
const K_ARRIVE = 950;
const K_TIMEOUT = 951;

interface LoadSlice {
  prompt: number[];
  output: number[];
  session: number[];
  timeoutMs: number[];
  slotOf: number[];
  timeoutEv: number[];
  firstToken: number[];
  outcome: number[];
}

const loadOf = (state: DayState) => (state as unknown as { e5load: LoadSlice }).e5load;

/** E6's role in miniature: arrivals at scripted times, and a timeout to first token. */
function loadModule(
  arrivals: { atMs: number; prompt: number; output: number; session: number; timeoutMs: number }[],
) {
  return {
    name: 'e5load',
    init(_state: DayState, ctx: Ctx): LoadSlice {
      arrivals.forEach((a, i) => ctx.schedule(ctx.dayStartMs + a.atMs, K_ARRIVE, i));
      const n = arrivals.length;
      return {
        prompt: arrivals.map((a) => a.prompt),
        output: arrivals.map((a) => a.output),
        session: arrivals.map((a) => a.session),
        timeoutMs: arrivals.map((a) => a.timeoutMs),
        slotOf: new Array<number>(n).fill(-1),
        timeoutEv: new Array<number>(n).fill(-1),
        firstToken: new Array<number>(n).fill(NaN),
        outcome: new Array<number>(n).fill(-1),
      };
    },
    events: [
      {
        kind: K_ARRIVE,
        name: 'e5load.arrive',
        priority: PRIORITY.arrival,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const l = loadOf(state);
          const i = ev.a;
          const t = state.shared.requests;
          const s = allocRequest(t);
          t.session[s] = l.session[i]!;
          t.analyst[s] = 0;
          t.turn[s] = 1;
          t.kind[s] = REQUEST_KIND.turn;
          t.arriveMs[s] = ctx.nowMs;
          t.promptTokens[s] = l.prompt[i]!;
          t.systemPromptTokens[s] = 0;
          t.outputTarget[s] = l.output[i]!;
          l.slotOf[i] = s;
          l.timeoutEv[i] = ctx.schedule(ctx.nowMs + l.timeoutMs[i]!, K_TIMEOUT, i);
          ctx.notify(TOPIC.requestArrived, s);
        },
      },
      {
        kind: K_TIMEOUT,
        name: 'e5load.timeout',
        priority: PRIORITY.client,
        handle(state: DayState, ev: { a: number }, ctx: Ctx) {
          const l = loadOf(state);
          l.timeoutEv[ev.a] = -1;
          if (l.outcome[ev.a] === -1) ctx.notify(TOPIC.requestCancelled, l.slotOf[ev.a]!);
        },
      },
    ],
    notices: [
      {
        topic: TOPIC.firstToken,
        handle(state: DayState, n: { a: number }, ctx: Ctx) {
          const l = loadOf(state);
          const i = l.slotOf.indexOf(n.a);
          l.firstToken[i] = ctx.nowMs;
          ctx.cancel(l.timeoutEv[i]!);
          l.timeoutEv[i] = -1;
        },
      },
      {
        topic: TOPIC.requestEnded,
        handle(state: DayState, n: { a: number; b: number }, ctx: Ctx) {
          const l = loadOf(state);
          const i = l.slotOf.indexOf(n.a);
          l.outcome[i] = n.b;
          l.slotOf[i] = -1;
          ctx.cancel(l.timeoutEv[i]!);
          l.timeoutEv[i] = -1;
        },
      },
    ],
  } as unknown as EngineModule;
}

function run(policy: RoutingPolicy, eventJumping: boolean, seed: number) {
  const w = randomWorkload(seed, cal);
  const arrivals = w.script.requests
    .filter((r) => r.after === undefined)
    .map((r, i) => ({
      atMs: r.atMs,
      prompt: r.promptTokens - (r.systemPromptTokens ?? 0),
      output: r.outputTokens,
      session: i,
      timeoutMs: 15_000,
    }));
  const config = testConfig({
    replicas: 2,
    routerOverheadMs: 2,
    engineOverrides: w.config.engineOverrides,
    tunable: { routingPolicy: policy, signalRefreshMs: 500 },
  });
  const runner = createDayRunner(
    [
      sharedModule,
      loadModule(arrivals),
      routerModule,
      createReplicaModule({ eventJumping }),
      metricsModule,
    ],
    { assertEveryEvent: true },
  );
  const r = runner.createDayRun(harnessInput(withEngine(cal, w.cal.engine), config));
  const chunks: ResultChunk[] = [];
  for (let t = 60_000; t <= 600_000; t += 60_000)
    chunks.push(r.advance(r.state.core.dayStartMs + t));
  r.assertInvariants();
  return { load: loadOf(r.state), chunks, state: r.state };
}

describe('with the router and metrics modules', () => {
  it('requests flow through; metrics see what the replica meters', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { load, chunks, state } = run('leastOutstanding', true, seed);
      expect(load.outcome.includes(-1), `seed ${seed}`).toBe(false);
      const ended = chunks.reduce((n, c) => n + c.requests.count, 0);
      expect(ended).toBe(load.outcome.length);
      const finished = chunks.reduce(
        (n, c) => n + c.requests.outcome.filter((o) => o === OUTCOME.finished).length,
        0,
      );
      expect(finished).toBe(load.outcome.filter((o) => o === OUTCOME.finished).length);
      // Busy time in the scalar buckets equals the replica meters (the day's work is done).
      for (let r = 0; r < 2; r++) {
        let busy = 0;
        for (const c of chunks) {
          const sc = c.scalars;
          for (let b = 0; b < sc.count; b++)
            busy += sc.data.busyMs[b * sc.series + replicaSeries(r)]!;
        }
        const meter = state.shared.meters.replica.busyMs[r]!;
        expect(Math.abs(busy - meter)).toBeLessThan(1e-3 * Math.max(1, meter));
      }
    }
  });

  it('jumping and per-step runs agree under a load-blind policy', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const a = run('roundRobin', true, seed).load;
      const b = run('roundRobin', false, seed).load;
      expect(a.outcome).toEqual(b.outcome);
      for (let i = 0; i < a.firstToken.length; i++) {
        const [x, y] = [a.firstToken[i]!, b.firstToken[i]!];
        expect(Number.isNaN(x) ? Number.isNaN(y) : Math.abs(x - y) < 1e-6).toBe(true);
      }
    }
  });
});
