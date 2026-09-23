import { describe, expect, it, vi } from 'vitest';
import { calibration } from '../data/calibration.ts';
import { WEEK_MS, dayOf, simMs, type SimMs } from '../engine/time.ts';
import { FIXTURE_TRACKED_ANALYST, makeFixtureChunk } from '../fixtures/chunks.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { toWorkerScenario } from '../scenarios/schema.ts';
import type { MainToWorker, WorkerToMain } from '../worker/protocol.ts';
import { createFakeTransport } from './fake-transport.ts';
import { createFixtureResultsStore, type FixtureResultsStore } from './fixture-results.ts';
import { createManualClock, createTaskQueue } from './manual.ts';
import { rangeEndAt } from './ranges.ts';
import { MAX_FRAME_WALL_MS, createPlaybackStore } from './store.ts';

// Tab 1 placeholder: 1 replica, shift 07:00–17:00, entry Wednesday 10:28 at 5×, 1-minute histogram buckets.
const scenario = fixtureScenarios()[0]!;
const ENTRY = scenario.entry.atMs;

function setup() {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const transport = createFakeTransport({ schedule: queue.schedule });
  const post = vi.spyOn(transport, 'postMessage');
  const delivered: WorkerToMain[] = [];
  transport.onMessage((m) => delivered.push(m));
  const onError = vi.fn();
  let results: FixtureResultsStore | undefined;
  const store = createPlaybackStore({
    transport,
    createResults: (n) => (results = createFixtureResultsStore(n)),
    clock,
    frames: clock,
    onError,
  });
  const sentOf = <T extends MainToWorker['type']>(type: T) =>
    post.mock.calls
      .map(([m]) => m)
      .filter((m): m is Extract<MainToWorker, { type: T }> => m.type === type);
  /** Runs the fake engine until the store's computed time reaches t. */
  const computeThrough = (t: SimMs) =>
    queue.runUntil(() => (rangeEndAt(store.getState().computed, t - 1) ?? -1) >= t);
  const state = () => store.getState();
  return {
    store,
    transport,
    queue,
    clock,
    results: results!,
    sentOf,
    delivered,
    onError,
    computeThrough,
    state,
  };
}

function loaded() {
  const t = setup();
  t.store.loadScenario(scenario);
  return t;
}

describe('loading a scenario', () => {
  it('opens paused at the entry point and sends init', () => {
    const { store, results, sentOf, queue, state, computeThrough } = loaded();
    expect(state()).toMatchObject({
      scenarioId: 'long-prompt',
      runId: 1,
      revision: 0,
      playheadMs: ENTRY,
      playing: false,
      speed: 5,
      mode: 'live',
      computed: [],
      forks: [],
      trackedAnalyst: null,
      buffering: true, // nothing is computed yet
    });
    const [init] = sentOf('init');
    expect(init).toMatchObject({ runId: 1, focusMs: ENTRY, calibration });
    expect(init!.scenario).toEqual(toWorkerScenario(scenario));
    expect(results.calls[0]).toEqual({ method: 'reset', replicas: 1 });

    queue.runUntil(() => state().trackedAnalyst !== null);
    expect(state().trackedAnalyst).toBe(FIXTURE_TRACKED_ANALYST);
    computeThrough(ENTRY + 1);
    expect(state().buffering).toBe(false);
    expect(state().computed[0]!.fromMs).toBe(simMs(2, 0));
    expect(store.index.computed()).toBe(results.callsOf('setComputed').at(-1)!.ranges);
    expect(results.callsOf('addChunk').length).toBeGreaterThan(0);
  });
});

describe('play, pause, speed, seek', () => {
  it('advances by wall time × speed while playing, and not while paused', () => {
    const { store, clock, state, computeThrough } = loaded();
    computeThrough(simMs(2, 11));
    store.play();
    expect(state().playing).toBe(true);
    clock.frame(100);
    expect(state().playheadMs).toBe(ENTRY + 500);
    clock.frames(9, 100);
    expect(state().playheadMs).toBe(ENTRY + 5_000);
    store.pause();
    expect(state().playing).toBe(false);
    clock.frames(5, 100);
    expect(state().playheadMs).toBe(ENTRY + 5_000);
    expect(clock.pendingFrames).toBe(0);
    // Resuming does not count the paused wall time.
    clock.advance(60_000);
    store.play();
    clock.frame(100);
    expect(state().playheadMs).toBe(ENTRY + 5_500);
  });

  it('clamps speed to 1..1000 and caps a single frame step', () => {
    const { store, clock, state, computeThrough } = loaded();
    for (const [input, expected] of [
      [0, 1],
      [-5, 1],
      [5000, 1000],
      [Infinity, 1000],
      [NaN, 1],
      [250, 250],
    ] as const) {
      store.setSpeed(input);
      expect(state().speed).toBe(expected);
    }
    computeThrough(simMs(2, 12));
    store.setSpeed(10);
    store.play();
    clock.frame(5_000); // a background tab coming back
    expect(state().playheadMs).toBe(ENTRY + MAX_FRAME_WALL_MS * 10);
  });

  it('seeks within the week and keeps playing from the new time', () => {
    const { store, clock, state, computeThrough } = loaded();
    computeThrough(simMs(2, 12));
    store.seek(simMs(2, 11));
    expect(state().playheadMs).toBe(simMs(2, 11));
    store.play();
    clock.frame(200);
    expect(state().playheadMs).toBe(simMs(2, 11) + 1_000);
    store.seek(simMs(2, 9));
    clock.frame(200);
    expect(state().playheadMs).toBe(simMs(2, 9) + 1_000);
    store.seek(-10);
    expect(state().playheadMs).toBe(0);
    store.seek(WEEK_MS + 10);
    expect(state().playheadMs).toBe(WEEK_MS - 1);
    store.seek(NaN);
    expect(state().playheadMs).toBe(WEEK_MS - 1);
  });

  it('skips off-shift hours and stops at the end of Friday’s shift', () => {
    const { store, clock, state, queue } = loaded();
    queue.runAll();
    store.setSpeed(1000);
    store.seek(simMs(0, 16, 59, 59));
    store.play();
    clock.frame(16); // 16 s simulated: 1 s to the end of Monday's shift, 15 s into Tuesday's
    expect(state().playheadMs).toBe(simMs(1, 7, 0, 15));

    store.seek(simMs(1, 3)); // night: shown as is, not buffering
    expect(state()).toMatchObject({ playheadMs: simMs(1, 3), buffering: false });
    clock.frame(16);
    expect(state().playheadMs).toBe(simMs(1, 7, 0, 16));

    store.seek(simMs(4, 16, 59, 50));
    clock.frame(16);
    expect(state()).toMatchObject({ playheadMs: simMs(4, 17), playing: false, buffering: false });
    store.play();
    expect(state().playing).toBe(false);
  });
});

describe('computed time', () => {
  it('holds with buffering at uncomputed time and resumes once computed', () => {
    const { store, clock, state, queue, computeThrough } = loaded();
    computeThrough(simMs(2, 10, 30));
    expect(rangeEndAt(state().computed, ENTRY)).toBe(simMs(2, 10, 30));
    store.setSpeed(100);
    store.play();
    clock.frames(20, 100); // 200 s simulated wanted, 120 s available
    expect(state()).toMatchObject({ playheadMs: simMs(2, 10, 30), buffering: true, playing: true });
    clock.frames(5, 100);
    expect(state().playheadMs).toBe(simMs(2, 10, 30));

    queue.runUntil(() => !state().buffering);
    expect(state().playing).toBe(true);
    clock.frame(100);
    expect(state().playheadMs).toBe(simMs(2, 10, 30, 10));
  });

  it('sends focus when the playhead enters another day', () => {
    const { store, clock, state, queue, sentOf } = loaded();
    queue.runAll();
    store.seek(simMs(2, 16, 59, 59)); // same day as the entry point
    expect(sentOf('focus')).toEqual([]);
    store.setSpeed(1000);
    store.play();
    clock.frame(16);
    expect(state().playheadMs).toBe(simMs(3, 7, 0, 15));
    expect(sentOf('focus')).toEqual([{ type: 'focus', runId: 1, atMs: simMs(3, 7, 0, 15) }]);
    store.pause();
    store.seek(simMs(0, 10));
    store.seek(simMs(0, 11));
    expect(sentOf('focus').map((m) => m.atMs)).toEqual([simMs(3, 7, 0, 15), simMs(0, 10)]);
  });

  it('asks for the next day before playback reaches its uncomputed start', () => {
    const { store, clock, state, queue, sentOf, results } = loaded();
    queue.runUntil(() => results.callsOf('addRollup').length === 1);
    expect(state().computed).toEqual([{ fromMs: simMs(2, 0), toMs: simMs(3, 0) }]);
    store.seek(simMs(2, 16));
    store.setSpeed(1000);
    store.play();
    clock.frame(16);
    expect(dayOf(state().playheadMs)).toBe(2);
    expect(sentOf('focus')).toEqual([{ type: 'focus', runId: 1, atMs: simMs(3, 7) }]);
    clock.frames(3, 16);
    expect(sentOf('focus')).toHaveLength(1);
  });
});

describe('fork', () => {
  it('cuts at the playhead, keeps history before the cut, records a marker, and drops stale data', () => {
    const { store, state, queue, results, sentOf, delivered, computeThrough } = loaded();
    computeThrough(simMs(2, 10, 45));
    queue.runNext(); // the engine computes [10:45, 11:00) under revision 0; its messages are in flight
    const before = results.calls.length;
    store.seek(simMs(2, 10, 40, 30));
    store.fork({ kind: 'set', atMs: 0, changes: { loadMultiplier: 2 } }, 'Load ×2');

    expect(state()).toMatchObject({
      revision: 1,
      forks: [{ atMs: simMs(2, 10, 40, 30), revision: 1, label: 'Load ×2' }],
      computed: [{ fromMs: simMs(2, 0), toMs: simMs(2, 10, 40) }],
      buffering: true,
    });
    expect(sentOf('fork')).toEqual([
      {
        type: 'fork',
        runId: 1,
        revision: 1,
        patch: { kind: 'set', atMs: simMs(2, 10, 40, 30), changes: { loadMultiplier: 2 } },
      },
    ]);
    const after = results.calls.slice(before);
    expect(after.filter((c) => c.method === 'reset')).toEqual([]);
    expect(results.callsOf('cut')).toEqual([
      { method: 'cut', day: 2, cutMs: simMs(2, 10, 40), lasting: true },
    ]);

    queue.runUntil(() => !state().buffering);
    const stale = delivered.find(
      (m) => m.type === 'chunk' && m.revision === 0 && m.chunk.fromMs === simMs(2, 10, 45),
    );
    expect(stale).toBeDefined();
    const added = results.calls.slice(before).filter((c) => c.method === 'addChunk');
    expect(added.map((c) => c.chunk.fromMs)).toEqual([simMs(2, 10, 40)]);
    expect(state().computed).toEqual([{ fromMs: simMs(2, 0), toMs: simMs(2, 10, 45) }]);
  });

  it('keeps older-revision data that the fork does not touch', () => {
    const { store, state, queue, results, transport, computeThrough } = loaded();
    computeThrough(simMs(2, 11));
    store.seek(simMs(2, 10, 30));
    store.fork({ kind: 'event', atMs: 0, event: { type: 'crash', replica: 0 } }, 'Crash');
    const cutsBefore = results.callsOf('cut').length;
    const monday = makeFixtureChunk({ replicas: 1 }, simMs(0, 9), simMs(0, 9, 15));
    const straddling = makeFixtureChunk({ replicas: 1 }, simMs(2, 10, 15), simMs(2, 10, 45));
    const emit = (m: WorkerToMain) => transport.emit(m);
    emit({ type: 'chunk', runId: 1, revision: 0, chunk: monday });
    emit({ type: 'chunk', runId: 1, revision: 0, chunk: straddling });
    emit({ type: 'dayComplete', runId: 1, revision: 0, day: 0, rollup: [] });
    emit({ type: 'dayComplete', runId: 1, revision: 0, day: 2, rollup: [] });
    emit({ type: 'progress', runId: 1, revision: 0, computed: [{ fromMs: 0, toMs: WEEK_MS }] });
    queue.runUntil(() => results.callsOf('addChunk').some((c) => c.chunk === straddling));
    queue.runAll(4);

    const addedChunks = results.callsOf('addChunk').map((c) => c.chunk);
    expect(addedChunks).toContain(monday);
    expect(results.callsOf('cut').slice(cutsBefore)).toEqual([
      { method: 'cut', day: 2, cutMs: simMs(2, 10, 30), lasting: false },
    ]);
    expect(results.callsOf('addRollup').map((c) => c.day)).toEqual([0]);
    expect(rangeEndAt(state().computed, simMs(2, 0))).toBeLessThan(simMs(2, 11));
    expect(state().revision).toBe(1);
  });

  it('accumulates markers and survives jumping back to the entry point', () => {
    const { store, state, clock, computeThrough } = loaded();
    computeThrough(simMs(2, 12));
    store.seek(simMs(2, 11));
    store.fork({ kind: 'set', atMs: 0, changes: {} }, 'A');
    store.seek(simMs(2, 10, 50));
    store.fork({ kind: 'set', atMs: 0, changes: {} }, 'B');
    store.setSpeed(50);
    store.play();
    clock.frame(16);
    store.jumpToEntry();
    expect(state()).toMatchObject({ playheadMs: ENTRY, playing: false, speed: 5, revision: 2 });
    expect(state().forks.map((f) => f.label)).toEqual(['A', 'B']);
  });
});

describe('reset and stale runs', () => {
  it('starts a new run at the entry point with forks cleared', () => {
    const { store, state, queue, results, sentOf, clock, computeThrough } = loaded();
    computeThrough(simMs(2, 12));
    store.setMode('highSide');
    store.setSpeed(200);
    store.play();
    clock.frames(3);
    store.fork({ kind: 'set', atMs: 0, changes: { loadMultiplier: 1.5 } }, 'Load');
    store.reset();
    expect(state()).toMatchObject({
      runId: 2,
      revision: 0,
      playheadMs: ENTRY,
      playing: false,
      speed: 5,
      mode: 'live',
      computed: [],
      forks: [],
      trackedAnalyst: null,
    });
    expect(sentOf('reset')).toEqual([{ type: 'reset', runId: 2, focusMs: ENTRY }]);
    expect(results.callsOf('reset')).toHaveLength(2);
    queue.runUntil(() => state().trackedAnalyst !== null);
    queue.runUntil(() => !state().buffering);
    expect(state().forks).toEqual([]);
  });

  it('drops messages from an earlier run', () => {
    const { store, state, queue, results, transport } = loaded();
    queue.runAll(20);
    store.reset();
    const n = results.calls.length;
    const chunk = makeFixtureChunk({ replicas: 1 }, simMs(2, 9), simMs(2, 9, 15));
    transport.emit({ type: 'ready', runId: 1, trackedAnalyst: 99 });
    transport.emit({ type: 'chunk', runId: 1, revision: 0, chunk });
    transport.emit({
      type: 'progress',
      runId: 1,
      revision: 0,
      computed: [{ fromMs: 0, toMs: WEEK_MS }],
    });
    transport.emit({ type: 'dayComplete', runId: 1, revision: 0, day: 2, rollup: [] });
    queue.runUntil(() => state().trackedAnalyst !== null);
    queue.runUntil(() => state().computed.length > 0);
    expect(state().trackedAnalyst).toBe(FIXTURE_TRACKED_ANALYST);
    expect(results.callsOf('addChunk').some((c) => c.chunk === chunk)).toBe(false);
    expect(state().computed[0]!.toMs).toBeLessThan(WEEK_MS);
    expect(results.calls.slice(n).some((c) => c.method === 'addRollup')).toBe(false);
  });
});

describe('detail, tracking, errors', () => {
  it('requests detail around the playhead at dot speeds in Live mode', () => {
    const { store, state, queue, results, sentOf, computeThrough } = loaded();
    computeThrough(simMs(2, 10, 45));
    const windows = () => sentOf('requestDetail').map((m) => [m.fromMs, m.toMs]);
    // 10:28 is past the middle of [10:20, 10:30), so the next window is fetched too.
    expect(windows()).toEqual([
      [simMs(2, 10, 20), simMs(2, 10, 30)],
      [simMs(2, 10, 30), simMs(2, 10, 40)],
    ]);
    queue.runUntil(() => results.callsOf('addDetail').length === 2);
    expect(results.callsOf('addDetail')[0]!.chunk.requests.scope).toBe('all');

    computeThrough(simMs(2, 13));
    store.setSpeed(100);
    store.seek(simMs(2, 12));
    expect(windows()).toHaveLength(2);
    store.setSpeed(10);
    expect(windows().at(-1)).toEqual([simMs(2, 12), simMs(2, 12, 10)]);
    store.setMode('highSide');
    store.seek(simMs(2, 11));
    store.seek(simMs(2, 12, 1)); // already requested
    expect(windows()).toHaveLength(3);
    expect(state().mode).toBe('highSide');
  });

  it('switches the tracked analyst and keeps only its traces', () => {
    const { store, state, queue, results, sentOf, transport, computeThrough } = loaded();
    computeThrough(simMs(2, 11));
    store.track(12);
    expect(state().trackedAnalyst).toBe(12);
    expect(sentOf('track')).toEqual([{ type: 'track', runId: 1, analyst: 12 }]);
    queue.runUntil(() => results.callsOf('addTrace').length > 0);
    expect(results.callsOf('addTrace')[0]!.chunk.requests.analyst[0]).toBe(12);

    const n = results.callsOf('addTrace').length;
    const chunk = makeFixtureChunk({ replicas: 1 }, simMs(2, 9), simMs(2, 9, 15));
    transport.emit({ type: 'trace', runId: 1, revision: 0, analyst: 99, day: 2, chunk });
    transport.emit({ type: 'ready', runId: 1, trackedAnalyst: 5 });
    queue.runAll(10);
    expect(results.callsOf('addTrace')).toHaveLength(n);
    expect(state().trackedAnalyst).toBe(12);
    store.track(null);
    expect(state().trackedAnalyst).toBeNull();
  });

  it('reports engine errors', () => {
    const { queue, transport, onError } = loaded();
    transport.emit({ type: 'error', runId: 1, message: 'boom' });
    queue.runAll(3);
    expect(onError).toHaveBeenCalledWith('boom');
  });
});

describe('subscriptions and lifecycle', () => {
  it('publishes a new frozen state object per change', () => {
    const { store, state } = loaded();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = state();
    store.setSpeed(20);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state()).not.toBe(before);
    expect(before.speed).toBe(5);
    expect(Object.isFrozen(state())).toBe(true);
    expect(store.getState()).toBe(store.getState());
    store.setSpeed(20); // no change, no notification
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setSpeed(30);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does nothing before a scenario is loaded', () => {
    const { store, state, sentOf } = setup();
    store.play();
    store.seek(1000);
    store.fork({ kind: 'set', atMs: 0, changes: {} }, 'x');
    store.reset();
    expect(state()).toMatchObject({ scenarioId: null, playing: false, playheadMs: 0, forks: [] });
    expect(sentOf('fork')).toEqual([]);
  });

  it('stops everything on dispose', () => {
    const { store, state, clock, queue, transport, computeThrough } = loaded();
    computeThrough(simMs(2, 11));
    store.play();
    clock.frame(16);
    store.dispose();
    expect(transport.terminated).toBe(true);
    expect(state().playing).toBe(false);
    const at = state().playheadMs;
    clock.frames(3);
    queue.runAll(10);
    expect(state().playheadMs).toBe(at);
    expect(clock.pendingFrames).toBe(0);
  });
});
