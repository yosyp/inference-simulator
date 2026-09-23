// Rendering smoke tests for the stack: every chart 3 kind, both modes, 1 and 8 replicas; window
// and zoom; the keyboard readout; and the collapse under reduced motion.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, simMs } from '../engine/time.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { createFixturePlaybackStore } from '../playback/fixture-store.ts';
import type { Mode } from '../playback/types.ts';
import type { Chart3Kind } from '../scenarios/schema.ts';
import { ChartStack, pendingDaysAt } from './ChartStack.tsx';
import { NOT_COLLECTED_MESSAGE } from './NotCollectedPanel.tsx';
import { createStaticStore, scaleCounts } from './test-support.ts';

const SHIFT = { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS };
const KINDS: Chart3Kind[] = ['utilization', 'perReplicaLoad', 'offeredVsAdmitted'];

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(opts: { replicas: number; chart3: Chart3Kind; mode?: Mode; playheadMs?: number }) {
  const index = scaleCounts(createFakeIndex({ replicas: opts.replicas }), 100);
  const store = createStaticStore(index, {
    playheadMs: opts.playheadMs ?? simMs(2, 12),
    mode: opts.mode ?? 'live',
    forks: [{ atMs: simMs(2, 11), revision: 1, label: 'Load ×1.5' }],
  });
  const view = render(
    <ChartStack
      store={store}
      chart3={opts.chart3}
      shift={SHIFT}
      lessonMoment={{ atMs: simMs(2, 10, 30), label: 'Lesson' }}
      width={1000}
      maxHz={1000}
    />,
  );
  return { store, ...view };
}

describe('ChartStack rendering', () => {
  for (const chart3 of KINDS) {
    for (const replicas of [1, 8]) {
      it(`renders live ${chart3} with ${replicas} replica${replicas > 1 ? 's' : ''}`, () => {
        const { container } = setup({ replicas, chart3 });
        const charts = [...container.querySelectorAll('[data-chart]')].map((c) =>
          c.getAttribute('data-chart'),
        );
        expect(charts).toEqual(['latency', 'memory', chart3]);
        expect(container.querySelectorAll('[data-marker="playhead"]')).toHaveLength(3);
        expect(container.querySelectorAll('[data-marker="fork"]')).toHaveLength(3);
        expect(container.querySelectorAll('[data-marker="lesson"]')).toHaveLength(3);
        expect(container.querySelectorAll('path[data-series]').length).toBeGreaterThanOrEqual(5);
        const worst = container.querySelectorAll('[data-end-label]');
        expect(worst.length).toBe(replicas > 1 ? (chart3 === 'perReplicaLoad' ? 3 : 2) : 0);
        expect(screen.getByText('Wed 07:00–17:00')).toBeInTheDocument();
        expect(container.querySelector('[data-axis="time"] [data-tick]')).not.toBeNull();
      });

      it(`renders High side ${chart3} with ${replicas} replica${replicas > 1 ? 's' : ''}`, () => {
        const { container } = setup({
          replicas,
          chart3,
          mode: 'highSide',
          playheadMs: simMs(3, 13),
        });
        expect(container.querySelector('[data-chart="latency"]')).toBeNull();
        const bars = container.querySelectorAll('[data-chart="dailyBars"]');
        expect(bars).toHaveLength(chart3 === 'utilization' ? 2 : 1);
        expect(bars[0]!.getAttribute('data-metric')).toBe('meanE2eMs');
        // Monday to Wednesday are delivered by Thursday 13:00; Thursday itself stays empty.
        expect(bars[0]!.querySelectorAll('[data-bar]')).toHaveLength(3 * replicas);
        const pending = bars[0]!.querySelectorAll('[data-pending-day]');
        expect([...pending].map((p) => p.getAttribute('data-pending-day'))).toEqual(['3']);
        expect(screen.getAllByText(NOT_COLLECTED_MESSAGE)).toHaveLength(
          chart3 === 'utilization' ? 1 : 2,
        );
        expect(container.querySelector('[data-axis="time"] [data-day="4"]')!.textContent).toBe(
          'Fri',
        );
      });
    }
  }

  it('shows individual requests on a sparse tab', () => {
    const store = createStaticStore(scaleCounts(createFakeIndex({ replicas: 1 }), 0.001), {
      playheadMs: simMs(2, 12),
    });
    const { container } = render(
      <ChartStack store={store} chart3="utilization" shift={SHIFT} width={1000} />,
    );
    expect(container.querySelector('[data-chart="latency"]')!.getAttribute('data-mode')).toBe(
      'requests',
    );
    expect(
      container.querySelectorAll('[data-series="ttftRequests"] circle').length,
    ).toBeGreaterThan(0);
  });

  it('takes chart 3, the shift, and the lesson moment from the loaded scenario', () => {
    const store = createFixturePlaybackStore();
    const scenario = fixtureScenarios()[4]!;
    act(() => store.loadScenario(scenario));
    const { container } = render(<ChartStack store={store} width={1000} />);
    const charts = [...container.querySelectorAll('[data-chart]')].map((c) =>
      c.getAttribute('data-chart'),
    );
    expect(charts).toEqual(['latency', 'memory', 'perReplicaLoad']);
    expect(screen.getByText('Wed 07:00–17:00')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-marker="lesson"]')).toHaveLength(3);
    expect(screen.getByText(scenario.lessonMoment.label)).toBeInTheDocument();
    store.dispose();
  });

  it('uses rows passed by U7 instead of its own delivery filter', () => {
    const index = createFakeIndex({ replicas: 2 });
    const store = createStaticStore(index, { playheadMs: simMs(1, 9), mode: 'highSide' });
    const rows = index.rollup().filter((r) => r.day === 0);
    const { container } = render(
      <ChartStack
        store={store}
        chart3="utilization"
        shift={SHIFT}
        width={1000}
        rollupRows={rows}
      />,
    );
    expect(
      container.querySelector('[data-chart="dailyBars"]')!.querySelectorAll('[data-bar]'),
    ).toHaveLength(2);
    expect(pendingDaysAt(simMs(1, 9), rows)).toEqual([1]);
    expect(pendingDaysAt(simMs(1, 9), [])).toEqual([0, 1]);
  });
});

describe('ChartStack window and zoom', () => {
  it('follows the playhead to the next shift day', () => {
    const { store } = setup({ replicas: 1, chart3: 'utilization' });
    act(() => store.set({ playheadMs: simMs(3, 7, 1) }));
    expect(screen.getByText('Thu 07:00–17:00')).toBeInTheDocument();
  });

  it('zooms with buttons around the playhead, pages with playback, and resets', async () => {
    const user = userEvent.setup();
    const { store } = setup({ replicas: 1, chart3: 'utilization' });
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    // 2 h around 12:00, keeping 12:00 half-way along as it was on the 07:00–17:00 day.
    expect(screen.getByText('Wed 11:00–13:00')).toBeInTheDocument();
    act(() => store.set({ playheadMs: simMs(2, 13, 30) }));
    expect(screen.getByText('Wed 13:00–15:00')).toBeInTheDocument();
    // Zooming out keeps the playhead a quarter of the way along.
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('Wed 12:30–16:30')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Shift day' }));
    expect(screen.getByText('Wed 07:00–17:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  });

  it('starts a new run (tab load or Reset) at the default window', async () => {
    const user = userEvent.setup();
    const { store } = setup({ replicas: 1, chart3: 'utilization' });
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('Wed 10:00–14:00')).toBeInTheDocument();
    act(() => store.set({ runId: 2 }));
    expect(screen.getByText('Wed 07:00–17:00')).toBeInTheDocument();
  });

  it('reads values at a keyboard cursor and zooms from the keyboard', async () => {
    const user = userEvent.setup();
    const { container } = setup({ replicas: 8, chart3: 'perReplicaLoad' });
    const stack = screen.getByRole('group', { name: 'Charts' });
    stack.focus();
    await user.keyboard('{ArrowLeft}');
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toMatch(/^Latency at 11:50:00: TTFT p99 [\d.]+ (ms|s), TTFT mean/);
    expect(live.textContent).toMatch(/Load per replica at 11:50:00: Fleet average [\d.]+/);
    expect(container.querySelector('[data-marker="cursor"]')).not.toBeNull();
    expect(container.querySelector('[data-cursor-label]')!.textContent).toBe('11:50');
    await user.keyboard('{Escape}');
    expect(container.querySelector('[data-marker="cursor"]')).toBeNull();
    await user.keyboard('+');
    expect(screen.getByText('Wed 10:00–14:00')).toBeInTheDocument();
    await user.keyboard('0');
    expect(screen.getByText('Wed 07:00–17:00')).toBeInTheDocument();
  });
});

describe('ChartStack collapse', () => {
  it('switches to the High side at once under reduced motion', () => {
    stubReducedMotion(true);
    const { store, container } = setup({ replicas: 4, chart3: 'utilization' });
    act(() => store.set({ mode: 'highSide' }));
    expect(container.firstElementChild!.getAttribute('data-collapse')).toBe('1.000');
    expect(container.querySelector('[data-chart="latency"]')).toBeNull();
    expect(container.querySelectorAll('[data-chart="dailyBars"]')).toHaveLength(2);
    act(() => store.set({ mode: 'live' }));
    expect(container.firstElementChild!.getAttribute('data-collapse')).toBe('0.000');
    expect(container.querySelector('[data-chart="dailyBars"]')).toBeNull();
  });

  it('tweens between modes with full motion, overlapping the layers on the way', async () => {
    stubReducedMotion(false);
    const { store, container } = setup({ replicas: 4, chart3: 'utilization' });
    act(() => store.set({ mode: 'highSide' }));
    const root = container.firstElementChild!;
    await vi.waitFor(
      () => {
        expect(container.querySelector('[data-chart="latency"]')).not.toBeNull();
        expect(container.querySelector('[data-chart="dailyBars"]')).not.toBeNull();
      },
      { timeout: 1000, interval: 5 },
    );
    const p = Number(root.getAttribute('data-collapse'));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    await vi.waitFor(() => expect(container.querySelector('[data-chart="latency"]')).toBeNull(), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(root.getAttribute('data-collapse')).toBe('1.000'));
  });
});
