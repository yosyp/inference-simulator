import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simMs } from '../engine/time.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { vi } from 'vitest';
import { createFakeTransport } from './fake-transport.ts';
import { createFixtureResultsStore } from './fixture-results.ts';
import { createManualClock, createTaskQueue } from './manual.ts';
import { createPlaybackStore, type EngineClientStore } from './store.ts';
import type { PlaybackStore } from './types.ts';
import { usePlaybackSelector } from './use-playback-selector.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

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

let renders = 0;
function Playhead({ store, maxHz }: { store: PlaybackStore; maxHz?: number }) {
  renders++;
  const t = usePlaybackSelector(store, (s) => s.playheadMs, { maxHz });
  return <output>{t}</output>;
}

function Playing({ store }: { store: PlaybackStore }) {
  renders++;
  const playing = usePlaybackSelector(store, (s) => s.playing);
  return <output>{playing ? 'playing' : 'paused'}</output>;
}

/** Runs n 60 Hz frames, keeping the store clock and React's timers in step. */
function playFrames(clock: ReturnType<typeof createManualClock>, n: number) {
  for (let i = 0; i < n; i++) {
    act(() => {
      clock.frame(16);
      vi.advanceTimersByTime(16);
    });
  }
}

describe('usePlaybackSelector', () => {
  it('re-renders at most maxHz times a second while the playhead moves every frame', () => {
    const { store, clock } = loadedStore();
    renders = 0;
    render(<Playhead store={store} />);
    act(() => store.play());
    playFrames(clock, 60); // ~1 s
    expect(renders).toBeLessThanOrEqual(13);
    expect(renders).toBeGreaterThanOrEqual(8);
    act(() => store.pause());
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('status').textContent).toBe(String(store.getState().playheadMs));
  });

  it('honours maxHz', () => {
    const { store, clock } = loadedStore();
    renders = 0;
    render(<Playhead store={store} maxHz={2} />);
    act(() => store.play());
    playFrames(clock, 60);
    expect(renders).toBeLessThanOrEqual(4);
  });

  it('skips re-renders when the selection is unchanged', () => {
    const { store, clock } = loadedStore();
    renders = 0;
    render(<Playing store={store} />);
    act(() => store.play());
    playFrames(clock, 60);
    expect(renders).toBe(2);
    expect(screen.getByRole('status').textContent).toBe('playing');
  });

  it('updates when the results index changes without a state change', () => {
    const { store, queue } = loadedStore();
    function Version({ s }: { s: EngineClientStore }) {
      const v = usePlaybackSelector(s, (_, index) => index.version);
      return <output>{v}</output>;
    }
    render(<Version s={store} />);
    const before = store.index.version;
    act(() => {
      queue.runAll(3);
      vi.advanceTimersByTime(200);
    });
    expect(store.index.version).toBeGreaterThan(before);
    expect(screen.getByRole('status').textContent).toBe(String(store.index.version));
  });
});
