import { describe, expect, it, vi } from 'vitest';
import { simMs } from '../engine/time.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { createFakeTransport } from './fake-transport.ts';
import { createFixtureResultsStore } from './fixture-results.ts';
import { createFixturePlaybackStore } from './fixture-store.ts';
import { sceneAtPlayhead, subscribeFrame } from './frame.ts';
import { createManualClock, createTaskQueue } from './manual.ts';
import { createPlaybackStore } from './store.ts';
import type { PlaybackState, PlaybackStore } from './types.ts';

function loadedStore() {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const store = createPlaybackStore({
    transport: createFakeTransport({ schedule: queue.schedule }),
    createResults: (n) => createFixtureResultsStore(n),
    clock,
    frames: clock,
  });
  store.loadScenario(fixtureScenarios()[0]!);
  queue.runUntil(() => store.getState().computed.some((r) => r.toMs >= simMs(2, 11)));
  return { store, clock, queue };
}

describe('subscribeFrame', () => {
  it('runs every frame while playing and once per change while paused', () => {
    const { store, clock } = loadedStore();
    const seen: number[] = [];
    const unsubscribe = subscribeFrame(store, (s) => seen.push(s.playheadMs));
    clock.frame();
    expect(seen).toHaveLength(1); // initial draw
    clock.frames(3);
    expect(seen).toHaveLength(1); // nothing changed
    store.setMode('highSide');
    store.setSpeed(8); // two changes, one frame
    clock.frame();
    expect(seen).toHaveLength(2);
    store.play();
    clock.frames(4, 50);
    expect(seen).toHaveLength(6);
    // The callback sees the playhead of its own frame.
    expect(seen.at(-1)).toBe(store.getState().playheadMs);
    unsubscribe();
    clock.frames(2);
    expect(seen).toHaveLength(6);
  });

  it('coalesces notifications onto frames for any PlaybackStore', () => {
    const { store } = loadedStore();
    const listeners = new Set<() => void>();
    let state: PlaybackState = store.getState();
    // Only the PlaybackStore contract: no frame hook (spreading the store would copy it).
    const noop = () => {};
    const plain: PlaybackStore = {
      getState: () => state,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      index: store.index,
      loadScenario: noop,
      play: noop,
      pause: noop,
      setSpeed: noop,
      seek: noop,
      setMode: noop,
      fork: noop,
      reset: noop,
      jumpToEntry: noop,
      track: noop,
      dispose: noop,
    };
    const frames = createManualClock();
    const cb = vi.fn();
    subscribeFrame(plain, cb, frames);
    frames.frame();
    expect(cb).toHaveBeenCalledTimes(1);
    state = { ...state, playheadMs: state.playheadMs + 1 };
    listeners.forEach((l) => l());
    listeners.forEach((l) => l());
    frames.frame();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]![0]).toBe(state);
  });
});

describe('sceneAtPlayhead', () => {
  it('asks the index for dots at low speed and aggregate flow above the threshold', () => {
    const { store } = loadedStore();
    const sceneAt = vi.spyOn(store.index, 'sceneAt');
    sceneAtPlayhead(store.getState(), store.index);
    store.setSpeed(11);
    sceneAtPlayhead(store.getState(), store.index);
    expect(sceneAt.mock.calls.map((c) => c[1].detail)).toEqual(['dots', 'aggregate']);
    expect(sceneAt.mock.calls[0]![0]).toBe(store.getState().playheadMs);
  });
});

describe('createFixturePlaybackStore', () => {
  it('plays a fixture scenario with the default (setTimeout) fake engine', async () => {
    const clock = createManualClock();
    const store = createFixturePlaybackStore({ clock, frames: clock, fake: { chunksPerStep: 8 } });
    const scenario = fixtureScenarios()[3]!; // 2 replicas
    store.loadScenario(scenario);
    await vi.waitFor(() => expect(store.getState().buffering).toBe(false));
    expect(store.index.replicas).toBe(2);
    store.play();
    clock.frames(10, 16);
    expect(store.getState().playheadMs).toBeGreaterThan(scenario.entry.atMs);
    store.dispose();
  });
});
