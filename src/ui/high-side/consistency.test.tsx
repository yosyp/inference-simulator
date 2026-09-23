// One truth on the High side (00-build U7; 01 §8; 05 §9). A real playback store (U2) drives the
// fake engine into the real results index (U8), and the three surfaces render from it at once:
// ChartStack's daily bars (U4), WeekTimeline's arrival ticks (U5), and the rollup table. Across day
// boundaries, and while days are still computing out of order, they must agree on which days the
// off-site team has. Then switching back to Live must restore the same run, with nothing
// recomputed or lost.

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartStack } from '../../charts/index.ts';
import { DAY_MS, WEEK_MS, rollupDeliveryMs, simMs, type SimMs } from '../../engine/time.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import { createFakeTransport } from '../../playback/fake-transport.ts';
import { createResultsStore } from '../../playback/index/index.ts';
import { createManualClock, createTaskQueue } from '../../playback/manual.ts';
import { createPlaybackStore } from '../../playback/store.ts';
import { WeekTimeline } from '../timeline/index.ts';
import { deliveredRollupAt } from './delivered.ts';
import { RollupTable } from './RollupTable.tsx';

// Tab 5 placeholder: Server B (8 replicas), chart 3 per-replica load, entry Wednesday 10:28 at 5×.
// The fake engine computes Wednesday first, then Thursday, Friday, Monday, Tuesday.
const scenario = fixtureScenarios()[4]!;

beforeEach(() => {
  vi.useFakeTimers();
  // Instant collapse (K18), so the daily bars are drawn as soon as the mode changes.
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Surfaces {
  /** Days with at least one daily bar, and days drawn as pending outlines. */
  charts: { delivered: number[]; pending: number[] };
  /** Days whose column holds values, and days whose column is one pending cell. */
  table: { delivered: number[]; pending: number[] };
  /** Days whose arrival tick is at or left of the playhead. */
  timeline: { arrived: number[] };
}

const uniqueSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

function setup() {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const transport = createFakeTransport({ schedule: queue.schedule });
  const store = createPlaybackStore({
    transport,
    createResults: (n) => createResultsStore(n),
    clock,
    frames: clock,
    onError: (message) => {
      throw new Error(message);
    },
  });
  act(() => store.loadScenario(scenario));
  const { container } = render(
    <>
      <ChartStack store={store} width={1000} maxHz={1000} />
      <WeekTimeline store={store} />
      <RollupTable store={store} maxHz={1000} />
    </>,
  );

  /** Lets every throttled selector (charts 10 Hz, timeline 4 Hz, table 10 Hz) catch up. */
  const flush = () =>
    act(() => {
      vi.advanceTimersByTime(300);
    });
  const run = (done: () => boolean) => {
    act(() => queue.runUntil(done));
    flush();
  };
  const runAll = () => {
    act(() => {
      queue.runAll();
    });
    flush();
  };
  const seek = (t: SimMs) => {
    act(() => store.seek(t));
    flush();
  };
  /** Plays n frames of dtMs, keeping the store's clock and React's timers in step. */
  const frames = (n: number, dtMs = 16) => {
    for (let i = 0; i < n; i++) {
      act(() => {
        clock.frame(dtMs);
        vi.advanceTimersByTime(dtMs);
      });
    }
    flush();
  };

  const surfaces = (): Surfaces => {
    const bars = container.querySelector('[data-chart="dailyBars"][data-metric="meanE2eMs"]');
    const table = container.querySelector('table[data-metric]')!;
    const playhead = store.getState().playheadMs;
    const ticks = [...container.querySelectorAll<HTMLElement>('[data-part="rollup-tick"]')];
    return {
      charts: {
        delivered: uniqueSorted(
          [...(bars?.querySelectorAll('[data-bar]') ?? [])].map((b) =>
            Number(b.getAttribute('data-bar')!.split('-')[0]),
          ),
        ),
        pending: [...(bars?.querySelectorAll('[data-pending-day]') ?? [])].map((p) =>
          Number(p.getAttribute('data-pending-day')),
        ),
      },
      table: {
        delivered: uniqueSorted(
          [...table.querySelectorAll('td[data-cell]')].map((c) =>
            Number(c.getAttribute('data-cell')!.split('-')[0]),
          ),
        ),
        pending: [...table.querySelectorAll('td[data-pending]')]
          .filter((c) => c.getAttribute('data-status') !== 'future')
          .map((c) => Number(c.getAttribute('data-pending'))),
      },
      timeline: {
        // A tick's `left` is its arrival time as a share of the week (geometry.ts).
        arrived: ticks
          .map((el) => (parseFloat(el.style.left) / 100) * WEEK_MS)
          .filter((atMs) => atMs <= playhead)
          .map((atMs) => Math.round(atMs / DAY_MS - 1.5)),
      },
    };
  };

  return { store, transport, queue, container, flush, run, runAll, seek, frames, surfaces };
}

describe('High-side surfaces agree on what has arrived', () => {
  it('across day boundaries once the week is computed', () => {
    const { store, runAll, seek, surfaces, container } = setup();
    act(() => store.setMode('highSide'));
    runAll();

    // Every tick sits where the engine says its day's rows arrive, and Friday's lands after the week.
    const ticks = [...container.querySelectorAll<HTMLElement>('[data-part="rollup-tick"]')];
    expect(ticks.map((el) => el.style.left)).toEqual(
      [0, 1, 2, 3].map((d) => `${(rollupDeliveryMs(d as 0) / WEEK_MS) * 100}%`),
    );
    const delivery = new Map(store.index.rollup().map((r) => [r.day, r.deliveredAtMs]));
    expect([...delivery.values()]).toEqual([0, 1, 2, 3, 4].map((d) => rollupDeliveryMs(d as 0)));

    const cases: [label: string, t: SimMs, delivered: number[], pending: number[]][] = [
      ['Monday 10:00', simMs(0, 10), [], [0]],
      ['Tuesday 11:59', simMs(1, 11, 59), [], [0, 1]],
      ['Tuesday 12:00', simMs(1, 12), [0], [1]],
      ['Wednesday 14:00', simMs(2, 14), [0, 1], [2]],
      ['Thursday 09:00', simMs(3, 9), [0, 1], [2, 3]],
      ['Thursday 12:00', simMs(3, 12), [0, 1, 2], [3]],
      ['Friday 12:00', simMs(4, 12), [0, 1, 2, 3], [4]],
      ['Friday 16:59', simMs(4, 16, 59), [0, 1, 2, 3], [4]],
    ];
    for (const [label, t, delivered, pending] of cases) {
      seek(t);
      const s = surfaces();
      const want: Surfaces = {
        charts: { delivered, pending },
        table: { delivered, pending },
        timeline: { arrived: delivered },
      };
      expect({ label, ...s }).toEqual({ label, ...want });
      // The shared rule gives the same answer.
      const rule = deliveredRollupAt(store.index.rollup(), t, 8);
      expect(rule.deliveredDays).toEqual(delivered);
      expect(rule.pendingDays).toEqual(pending);
    }
  });

  it('while playing across Tuesday 12:00', () => {
    const { store, runAll, seek, surfaces, frames } = setup();
    act(() => store.setMode('highSide'));
    runAll();
    seek(simMs(1, 11, 58));
    expect(surfaces().table.delivered).toEqual([]);
    act(() => {
      store.setSpeed(1000);
      store.play();
    });
    // 16 ms frames at 1000× move 16 s each: 10 frames pass 12:00.
    frames(10);
    expect(store.getState().playheadMs).toBeGreaterThan(simMs(1, 12));
    expect(store.getState().playheadMs).toBeLessThan(simMs(1, 12, 1));
    expect(surfaces()).toEqual({
      charts: { delivered: [0], pending: [1] },
      table: { delivered: [0], pending: [1] },
      timeline: { arrived: [0] },
    });
  });

  it('while days are still computing out of order', () => {
    const { store, run, runAll, seek, surfaces, container } = setup();
    act(() => store.setMode('highSide'));
    const done = (d: number) => () => store.index.completedDays().includes(d as 0);

    // Only Wednesday (the entry day) is done. At Wednesday 10:28 Monday's rollup is due (Tuesday
    // 12:00 has passed) but not computed: charts and table both keep it pending.
    run(done(2));
    expect(store.index.completedDays()).toEqual([2]);
    expect(surfaces()).toEqual({
      charts: { delivered: [], pending: [0, 1, 2] },
      table: { delivered: [], pending: [0, 1, 2] },
      timeline: { arrived: [0] },
    });
    const status = (d: number) =>
      container.querySelector(`td[data-pending="${d}"]`)!.getAttribute('data-status');
    expect([0, 1, 2].map(status)).toEqual(['computing', 'awaiting', 'today']);

    // Thursday 14:00: Wednesday arrives on time although Monday and Tuesday are still computing.
    seek(simMs(3, 14));
    expect(surfaces()).toEqual({
      charts: { delivered: [2], pending: [0, 1, 3] },
      table: { delivered: [2], pending: [0, 1, 3] },
      timeline: { arrived: [0, 1, 2] },
    });

    // Monday finishes (after Thursday and Friday): its rows appear at once on both surfaces.
    run(done(0));
    expect(surfaces()).toEqual({
      charts: { delivered: [0, 2], pending: [1, 3] },
      table: { delivered: [0, 2], pending: [1, 3] },
      timeline: { arrived: [0, 1, 2] },
    });

    runAll();
    expect(surfaces()).toEqual({
      charts: { delivered: [0, 1, 2], pending: [3] },
      table: { delivered: [0, 1, 2], pending: [3] },
      timeline: { arrived: [0, 1, 2] },
    });
  });
});

describe('Switching back to Live', () => {
  it('restores the same run: nothing recomputed, nothing lost', () => {
    const { store, transport, runAll, seek, flush, container, queue } = setup();
    runAll();
    const before = {
      state: store.getState(),
      version: store.index.version,
      rollup: store.index.rollup(),
      computed: store.index.computed(),
    };
    expect(container.querySelector('[data-chart="latency"]')).not.toBeNull();
    const sent = transport.received.length;

    // Live → High side → Live at the same playhead: the index is untouched and the worker hears
    // nothing, before or after its queue drains.
    act(() => store.setMode('highSide'));
    flush();
    expect(container.querySelector('[data-chart="latency"]')).toBeNull();
    // Wednesday 10:28: only Monday has arrived.
    expect(container.querySelectorAll('[data-chart="dailyBars"] [data-bar]').length).toBe(8);
    expect(store.index.version).toBe(before.version);
    act(() => store.setMode('live'));
    flush();
    runAll();
    expect(queue.size).toBe(0);
    expect(transport.received.length).toBe(sent);
    expect(store.index.version).toBe(before.version);
    expect(store.index.rollup()).toBe(before.rollup);
    expect(store.index.computed()).toBe(before.computed);
    const after = store.getState();
    expect(after).toEqual({ ...before.state, mode: 'live' });
    expect(container.querySelector('[data-chart="latency"]')).not.toBeNull();
    expect(container.querySelector('[data-chart="dailyBars"]')).toBeNull();
    expect(container.querySelector('[data-part="rollup-tick"]')).toBeNull();

    // Moving while on the High side, then switching back: the switch itself changes nothing, and
    // the only message is Live's per-request detail for the canvas at the new playhead (U2); the
    // computed week and every rollup row are kept.
    act(() => store.setMode('highSide'));
    seek(simMs(3, 15));
    runAll();
    const version = store.index.version;
    const sentHigh = transport.received.length;
    act(() => store.setMode('live'));
    expect(store.index.version).toBe(version);
    runAll();
    const types = transport.received.slice(sentHigh).map((m) => m.type);
    expect(types).toEqual(['requestDetail']);
    expect(store.index.rollup()).toBe(before.rollup);
    expect(store.index.computed()).toEqual(before.computed);
    expect(store.getState()).toMatchObject({
      runId: before.state.runId,
      revision: before.state.revision,
      forks: before.state.forks,
      computed: before.state.computed,
      mode: 'live',
    });
    expect(container.querySelector('[data-chart="latency"]')).not.toBeNull();
  });
});
