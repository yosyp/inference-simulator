// The README's worked example, compiled and run. Slice names carry an e2 prefix so they can't
// collide with the real modules' augmentations (README uses `signals` and `replica`).

import { describe, expect, it } from 'vitest';
import type { DayRunInput, SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { REPLICA_STATE } from '../results.ts';
import { DAY_MS, dayStartMs } from '../time.ts';
import {
  NO_EVENT,
  PRIORITY,
  TOPIC,
  createDayRunner,
  createLevel,
  defineModule,
  setLevel,
  takeLevelMean,
  type Ctx,
  type DayState,
  type Level,
} from './index.ts';

interface SignalSlice {
  seen: Float64Array;
  ready: Uint8Array;
  refreshEv: number;
  staleness: Level;
}

interface StubReplicaSlice {
  outstanding: Float64Array;
}

declare module './types.ts' {
  interface DayState {
    e2signals: SignalSlice;
    e2replica: StubReplicaSlice;
  }
}

const EV_REFRESH = 990;

function refresh(state: DayState, ctx: Ctx): void {
  const s = state.e2signals;
  const replicas = state.e2replica;
  for (let r = 0; r < s.seen.length; r++) s.seen[r] = replicas.outstanding[r]!;
  setLevel(s.staleness, ctx.nowMs, 0);
  s.refreshEv = ctx.schedule(ctx.nowMs + state.core.params.signalRefreshMs, EV_REFRESH);
}

const signalsModule = defineModule({
  name: 'e2signals',
  init(_state, ctx) {
    const n = ctx.input.config.replicas;
    const refreshEv = ctx.schedule(ctx.dayStartMs, EV_REFRESH);
    return {
      seen: new Float64Array(n),
      ready: new Uint8Array(n).fill(1),
      refreshEv,
      staleness: createLevel(ctx.nowMs),
    };
  },
  events: [
    {
      kind: EV_REFRESH,
      name: 'signals.refresh',
      priority: PRIORITY.router,
      handle: (state, _ev, ctx) => refresh(state, ctx),
    },
  ],
  onParams(state, changes, ctx) {
    if (changes.signalRefreshMs === undefined) return;
    const s = state.e2signals;
    s.refreshEv = ctx.reschedule(s.refreshEv, ctx.nowMs + changes.signalRefreshMs, EV_REFRESH);
  },
  notices: [
    {
      topic: TOPIC.replicaState,
      handle(state, n) {
        state.e2signals.ready[n.a] = n.b === REPLICA_STATE.ready ? 1 : 0;
      },
    },
  ],
  onBucketEnd(state, boundaryMs) {
    takeLevelMean(state.e2signals.staleness, boundaryMs);
  },
  assertInvariants(state, ctx) {
    if (!ctx.isPending(state.e2signals.refreshEv) && state.e2signals.refreshEv !== NO_EVENT) {
      throw new Error('signals: lost the refresh event');
    }
  },
});

// A stand-in replica module: replica 0's outstanding count rises by one each second, and a crash
// injected by patch is announced on TOPIC.replicaState (E8's job in the real engine).
const EV_TICK = 991;
const replicaStub = defineModule({
  name: 'e2replica',
  init(_state, ctx) {
    ctx.schedule(ctx.dayStartMs + 250, EV_TICK);
    return { outstanding: new Float64Array(ctx.input.config.replicas) };
  },
  events: [
    {
      kind: EV_TICK,
      name: 'replicaStub.tick',
      priority: PRIORITY.engine,
      handle(state, _ev, ctx) {
        state.e2replica.outstanding[0]!++;
        ctx.schedule(ctx.nowMs + 1_000, EV_TICK);
      },
    },
  ],
  onInjected(_state, event, ctx) {
    if (event.type === 'crash')
      ctx.notify(TOPIC.replicaState, event.replica, REPLICA_STATE.crashed);
  },
});

function config(): SimConfig {
  return {
    seed: 1,
    replicas: 2,
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
    bucketMs: 10_000,
    histBucketMs: 60_000,
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
      signalRefreshMs: 5_000,
      admissionLimitPerReplica: null,
      weightAffinity: 1,
      weightOutstanding: 1,
      weightKv: 1,
    },
  };
}

describe('README worked example', () => {
  it('samples stale signals, follows a refresh-interval patch, and hears replica state', () => {
    const start = dayStartMs(0);
    const input: DayRunInput = {
      config: config(),
      calibration: {} as Calibration,
      day: 0,
      patches: [
        { kind: 'set', atMs: start + 20_000, changes: { signalRefreshMs: 60_000 } },
        { kind: 'event', atMs: start + 30_000, event: { type: 'crash', replica: 1 } },
      ],
      trackedAnalyst: null,
      detail: 'tracked',
    };
    const run = createDayRunner([replicaStub, signalsModule], {
      assertEveryEvent: true,
    }).createDayRun(input);

    // Refreshes at 0, 5 s, 10 s, 15 s; ticks at 0.25 s, 1.25 s, ... so at 15 s it saw 15.
    run.advance(start + 19_999);
    expect(run.state.e2signals.seen[0]).toBe(15);
    expect(run.state.e2replica.outstanding[0]).toBe(20);

    // At 20 s the pending refresh moves to 20 s + 60 s; the crash at 30 s marks replica 1.
    run.advance(start + 79_999);
    expect(run.state.e2signals.seen[0]).toBe(15);
    expect([...run.state.e2signals.ready]).toEqual([1, 0]);
    run.advance(start + 80_001);
    expect(run.state.e2signals.seen[0]).toBe(80);
    run.advance(start + DAY_MS);
    run.assertInvariants();
    expect(run.state.e2signals.refreshEv).toBe(NO_EVENT); // the next refresh fell after the day
  });
});
