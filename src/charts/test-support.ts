// Test doubles for chart tests: a hand-driven PlaybackStore over any ResultsIndex, and an index
// wrapper that overrides chosen queries. Imported only by tests.

import type { PlaybackState, PlaybackStore, ResultsIndex } from '../playback/types.ts';
import type { Scenario } from '../scenarios/schema.ts';

export interface StaticStore extends PlaybackStore {
  /** Replaces part of the state and notifies subscribers. */
  set(patch: Partial<PlaybackState>): void;
}

const BASE_STATE: PlaybackState = {
  scenarioId: 'test',
  runId: 1,
  revision: 0,
  playheadMs: 0,
  playing: false,
  speed: 1,
  mode: 'live',
  buffering: false,
  computed: [],
  forks: [],
  trackedAnalyst: null,
};

export function createStaticStore(
  index: ResultsIndex,
  state: Partial<PlaybackState> = {},
  scenario: Scenario | null = null,
): StaticStore {
  let current: PlaybackState = { ...BASE_STATE, ...state };
  const listeners = new Set<() => void>();
  const noop = () => {};
  return {
    getState: () => current,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get index() {
      return index;
    },
    scenario,
    set(patch) {
      current = { ...current, ...patch };
      for (const l of [...listeners]) l();
    },
    loadScenario: noop,
    play: noop,
    pause: noop,
    setSpeed: noop,
    seek(atMs) {
      this.set({ playheadMs: atMs });
    },
    setMode(mode) {
      this.set({ mode });
    },
    fork: noop,
    reset: noop,
    jumpToEntry: noop,
    track: noop,
    dispose: noop,
  };
}

/** `base` with some queries replaced. */
export function withQueries(base: ResultsIndex, overrides: Partial<ResultsIndex>): ResultsIndex {
  return {
    get version() {
      return base.version;
    },
    get replicas() {
      return base.replicas;
    },
    computed: () => base.computed(),
    scalarSeries: (...a) => base.scalarSeries(...a),
    quantileSeries: (...a) => base.quantileSeries(...a),
    requestPoints: (...a) => base.requestPoints(...a),
    sceneAt: (...a) => base.sceneAt(...a),
    statusAt: (...a) => base.statusAt(...a),
    rollup: () => base.rollup(),
    completedDays: () => base.completedDays(),
    ...overrides,
  };
}

/** Scales every quantile point's request count by `factor` (a sparse workload). */
export function scaleCounts(base: ResultsIndex, factor: number): ResultsIndex {
  return withQueries(base, {
    quantileSeries: (...a) => {
      const q = base.quantileSeries(...a);
      return { ...q, counts: q.counts.map((c) => c * factor) };
    },
  });
}
