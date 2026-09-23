// End to end with the engine client: U2's playback store drives the fake engine and routes its
// messages (structured-cloned chunks, progress, forks, detail, traces) into createResultsStore.
// The results must match a results store fed the same fixture chunks directly.

import { describe, expect, it } from 'vitest';
import type { FixtureOptions } from '../../fixtures/synthetic.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import { DAY_MS, simMs } from '../../engine/time.ts';
import { FIXTURE_TRACKED_ANALYST, makeFixtureChunks } from '../../fixtures/chunks.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import { createFakeTransport } from '../fake-transport.ts';
import { createManualClock, createTaskQueue } from '../manual.ts';
import { rangeEndAt } from '../ranges.ts';
import { createPlaybackStore } from '../store.ts';
import type { ResultsIndex, ResultsStore } from '../types.ts';
import { createResultsStore } from './index.ts';

// Tab 5 placeholder: Server B (8 replicas), entry Wednesday 10:28 at 5×.
const scenario = fixtureScenarios()[4]!;
const DAY = 2;
const dayStart = DAY * DAY_MS;
const dayEnd = dayStart + DAY_MS;
const live = { mode: 'live', detail: 'dots', trackedAnalyst: FIXTURE_TRACKED_ANALYST } as const;

function setup() {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const transport = createFakeTransport({ schedule: queue.schedule });
  let results: ResultsStore | undefined;
  const store = createPlaybackStore({
    transport,
    createResults: (n) => (results = createResultsStore(n)),
    clock,
    frames: clock,
    onError: (message) => {
      throw new Error(message);
    },
  });
  store.loadScenario(scenario);
  const index = () => results!.index;
  /** Runs the fake engine until the day is computed and its rollup (posted last) has landed. */
  const computeDay = () =>
    queue.runUntil(
      () =>
        (rangeEndAt(store.getState().computed, dayEnd - 1) ?? -1) >= dayEnd &&
        index().completedDays().includes(DAY),
    );
  return { store, queue, index, computeDay };
}

/** A results store fed the fake engine's chunks for Wednesday directly. */
function direct(opts: FixtureOptions): ResultsIndex {
  const s = createResultsStore(opts.replicas);
  for (const c of makeFixtureChunks(opts, dayStart, dayEnd)) s.addChunk(c);
  return s.index;
}

const shift = { fromMs: simMs(DAY, 7), toMs: simMs(DAY, 17) };

function expectSameSeries(got: ResultsIndex, want: ResultsIndex, quantiles: boolean) {
  for (const series of [0, 1, 4, 8]) {
    for (const metric of ['kvUsedFrac', 'decodeTokens', 'kvUsedFracMax', 'offered'] as const) {
      const g = got.scalarSeries(metric, series, shift, 10_000);
      expect(g.v).toEqual(want.scalarSeries(metric, series, shift, 10_000).v);
    }
    const g = got.quantileSeries('ttft', series, shift, 10_000, [0.5, 0.99]);
    const w = want.quantileSeries('ttft', series, shift, 10_000, [0.5, 0.99]);
    expect(g.counts).toEqual(w.counts);
    if (quantiles) expect(g.values).toEqual(w.values);
  }
}

describe('createResultsStore behind the playback store and the fake engine', () => {
  it('holds the same data as a direct feed once the day is computed', () => {
    const { store, index, computeDay } = setup();
    computeDay();
    expectSameSeries(index(), direct({ replicas: 8 }), true);
    expect(index().computed()).toEqual(store.getState().computed);
    expect(index().completedDays()).toContain(DAY);
    const t = simMs(DAY, 11, 3, 7);
    expect(index().statusAt(t)).toEqual(direct({ replicas: 8 }).statusAt(t));
    expect(index().requestPoints(shift).t.length).toBe(200);
  });

  it('re-streams a crash fork from the cut and matches a direct feed with the crash', () => {
    const { store, index, computeDay } = setup();
    computeDay();
    const atMs = store.getState().playheadMs;
    store.fork({ kind: 'event', atMs: 0, event: { type: 'crash', replica: 3 } }, 'Crash');
    expect(index().completedDays()).not.toContain(DAY);
    computeDay();
    const want = direct({ replicas: 8, crash: { replica: 3, atMs } });
    // Chunk boundaries differ after the cut, which reshuffles fixture histogram samples within
    // buckets, so compare histogram counts rather than quantiles.
    expectSameSeries(index(), want, false);
    const loading = index().statusAt(atMs + 80_000).replicas[3]!;
    expect(loading.state).toBe(REPLICA_STATE.loadingWeights);
    expect(loading.phaseProgress).toBeCloseTo(0.4, 9);
    expect(index().completedDays()).toContain(DAY);
  });

  it('draws dots from detail the store requests at dot speed', () => {
    const { store, queue, index, computeDay } = setup();
    computeDay();
    // The fake's detail windows hold the tracked analyst's requests only: one every 3 minutes.
    const t = simMs(DAY, 10, 30, 3);
    queue.runUntil(() => index().sceneAt(t, live).detail === 'dots');
    const scene = index().sceneAt(t, live);
    expect(store.getState().speed).toBeLessThanOrEqual(10);
    expect(scene.detail).toBe('dots');
    const dots = scene.replicas.flatMap((r) => r.dots);
    expect(dots).toHaveLength(1);
    expect(dots[0]!.tracked).toBe(true);
    expect(index().sceneAt(simMs(DAY, 12), live).detail).toBe('aggregate');
  });

  it("swaps in a newly tracked analyst's trace", () => {
    const { store, queue, index, computeDay } = setup();
    computeDay();
    const t = simMs(DAY, 16);
    const before = index().sceneAt(t, live).tracked!.requests;
    expect(before.length).toBeGreaterThan(100);
    store.track(42);
    const trackedAt = () => index().sceneAt(t, { ...live, trackedAnalyst: 42 }).tracked!.requests;
    queue.runUntil(() => trackedAt().length > 0);
    const after = trackedAt();
    expect(after.map((r) => [r.request, r.state, r.replica, r.ttftMs])).toEqual(
      before.map((r) => [r.request, r.state, r.replica, r.ttftMs]),
    );
  });
});
