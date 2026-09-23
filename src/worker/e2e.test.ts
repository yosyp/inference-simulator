// End to end in one process: U2's playback store and U8's results store, driven by this engine
// host through an in-process transport that clones (and transfers) every message as postMessage
// would. Plays the lesson day of the 1-GPU fixture scenario and reads the chart queries.

import { describe, expect, it } from 'vitest';
import { patchAt } from '../engine/api.ts';
import { DAY_MS, simMs, type SimMs } from '../engine/time.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { createResultsStore } from '../playback/index/index.ts';
import { createManualClock } from '../playback/manual.ts';
import { rangeEndAt } from '../playback/ranges.ts';
import { createPlaybackStore } from '../playback/store.ts';
import type { EngineTransport } from '../playback/transport.ts';
import { createEngineHost } from './host.ts';
import type { MainToWorker, WorkerToMain } from './protocol.ts';

interface InProcess extends EngineTransport {
  /** Runs up to `limit` queued tasks (worker work and deliveries, in order); returns how many. */
  run(limit?: number): number;
  readonly received: MainToWorker[];
  readonly delivered: WorkerToMain[];
}

function inProcessTransport(): InProcess {
  const tasks: (() => void)[] = [];
  const handlers = new Set<(m: WorkerToMain) => void>();
  const received: MainToWorker[] = [];
  const delivered: WorkerToMain[] = [];
  const host = createEngineHost({
    post: (msg, transfer) => {
      const copy = structuredClone(msg, { transfer });
      tasks.push(() => {
        delivered.push(copy);
        for (const h of [...handlers]) h(copy);
      });
    },
    schedule: (task) => tasks.push(task),
    now: () => 0,
    sliceMs: 0,
  });
  return {
    postMessage(msg) {
      const copy = structuredClone(msg);
      received.push(copy);
      tasks.push(() => host.handle(copy));
    },
    onMessage(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    terminate() {
      host.dispose();
      handlers.clear();
    },
    run(limit = Infinity) {
      let n = 0;
      while (n < limit && tasks.length > 0) {
        tasks.shift()!();
        n++;
      }
      return n;
    },
    received,
    delivered,
  };
}

const scenario = fixtureScenarios()[0]!; // 1 GPU, lesson Wednesday 10:30, entry 10:28 at 5×
const DAY = 2;
const SHIFT = { fromMs: simMs(DAY, 7), toMs: simMs(DAY, 17) };

function setup() {
  const transport = inProcessTransport();
  const clock = createManualClock();
  const errors: string[] = [];
  const store = createPlaybackStore({
    transport,
    createResults: createResultsStore,
    clock,
    frames: clock,
    onError: (m) => errors.push(m),
  });
  const computedTo = (t: SimMs) => rangeEndAt(store.getState().computed, t) ?? -1;
  return { transport, clock, store, errors, computedTo };
}

describe(
  'engine host end to end with the playback and results stores',
  { timeout: 120_000 },
  () => {
    it('plays the lesson day of the 1-GPU fixture and the chart queries return data', () => {
      const { transport, clock, store, errors, computedTo } = setup();
      store.loadScenario(scenario);
      const entry = scenario.entry.atMs;
      // Compute until the entry point is playable.
      while (computedTo(entry) <= entry && transport.run(1) > 0);
      expect(computedTo(entry)).toBeGreaterThan(entry);
      expect(store.getState().trackedAnalyst).not.toBeNull();

      // A few frames at the entry speed: dots, and a detail request answered for this 'all' run.
      store.play();
      for (let i = 0; i < 5; i++) {
        clock.frame(100);
        transport.run(20);
      }
      expect(transport.received.some((m) => m.type === 'requestDetail')).toBe(true);
      const dotsScene = store.index.sceneAt(store.getState().playheadMs, {
        mode: 'live',
        detail: 'dots',
        trackedAnalyst: store.getState().trackedAnalyst,
      });
      expect(dotsScene.replicas).toHaveLength(1);

      // Then play through the rest of the day at 1000×, letting the worker run between frames.
      store.setSpeed(1000);
      for (let guard = 0; guard < 5_000 && store.getState().playheadMs < SHIFT.toMs - 1; guard++) {
        clock.frame(250);
        transport.run(10);
      }
      expect(store.getState().playheadMs).toBeGreaterThanOrEqual(SHIFT.toMs - 1);
      transport.run();
      expect(errors).toEqual([]);

      const index = store.index;
      const day = { fromMs: SHIFT.fromMs, toMs: SHIFT.toMs };
      const kv = index.scalarSeries('kvUsedFrac', 1, day, 200);
      expect(kv.v.some((v) => v > 0)).toBe(true);
      expect(kv.v.every((v) => Number.isFinite(v))).toBe(true);
      const finished = index.scalarSeries('finished', 0, day, 100);
      expect(finished.v.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
      const ttft = index.quantileSeries('ttft', 0, day, 100, [0.5, 0.99]);
      expect(ttft.values[0]!.some((v) => Number.isFinite(v) && v > 0)).toBe(true);
      expect(ttft.values[1]!.some((v) => Number.isFinite(v) && v > 0)).toBe(true);
      const points = index.requestPoints({ fromMs: simMs(DAY, 10), toMs: simMs(DAY, 11) });
      expect(points.t.length).toBeGreaterThan(0);
      const status = index.statusAt(scenario.lessonMoment.atMs);
      expect(status.replicas).toHaveLength(1);
      expect(index.completedDays()).toContain(DAY);
      expect(index.rollup().filter((r) => r.day === DAY)).toHaveLength(1);
      const tracked = store.getState().trackedAnalyst!;
      const scene = index.sceneAt(scenario.lessonMoment.atMs + 5 * 60_000, {
        mode: 'live',
        detail: 'dots',
        trackedAnalyst: tracked,
      });
      expect(scene.tracked?.analyst).toBe(tracked);
      expect(scene.tracked!.requests.length).toBeGreaterThan(0);
    });

    it('a fork from the store streams the new revision from the cut and the charts fill again', () => {
      const { transport, store, errors, computedTo } = setup();
      store.loadScenario(scenario);
      while (computedTo(SHIFT.fromMs) < SHIFT.toMs && transport.run(1) > 0);
      store.seek(simMs(DAY, 11, 2, 30));
      store.fork(patchAt({ kind: 'set', changes: { loadMultiplier: 2 } }, 0), 'Double the load');
      const state = store.getState();
      expect(state.revision).toBe(1);
      expect(computedTo(SHIFT.fromMs)).toBe(simMs(DAY, 11, 2));
      transport.run();
      expect(errors).toEqual([]);
      expect(computedTo(DAY * DAY_MS)).toBeGreaterThanOrEqual((DAY + 1) * DAY_MS);
      const after = { fromMs: simMs(DAY, 11, 2), toMs: simMs(DAY, 12, 2) };
      const offered = store.index.scalarSeries('offered', 0, after, 60);
      expect(offered.v.every((v) => Number.isFinite(v))).toBe(true);
      const before = store.index.scalarSeries(
        'offered',
        0,
        { fromMs: simMs(DAY, 10), toMs: simMs(DAY, 11) },
        60,
      );
      const sum = (a: Float64Array) => a.reduce((x, y) => x + y, 0);
      expect(sum(offered.v)).toBeGreaterThan(sum(before.v));
      // Every chunk after the fork carries the new revision and starts at or after the cut.
      const forkIndex = transport.delivered.findIndex((m) => 'revision' in m && m.revision === 1);
      for (const m of transport.delivered.slice(forkIndex)) {
        if (m.type !== 'chunk') continue;
        expect(m.revision).toBe(1);
        if (m.chunk.day === DAY) expect(m.chunk.fromMs).toBeGreaterThanOrEqual(simMs(DAY, 11, 2));
      }
    });
  },
);
