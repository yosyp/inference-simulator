import { Profiler } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_MS, simMs, type SimMs } from '../../engine/time.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import { createFixturePlaybackStore } from '../../playback/fixture-store.ts';
import { createManualClock, createTaskQueue } from '../../playback/manual.ts';
import { coversRange } from '../../playback/ranges.ts';
import { leftPercent, offShiftSpans, widthPercent } from './geometry.ts';
import { WeekTimeline } from './WeekTimeline.tsx';

// Tab 1 placeholder: 1 replica, shift 07:00–17:00, lesson moment Wednesday 10:30, entry Wednesday
// 10:28 at 5×. The fake engine computes the entry day first, then Thursday, Friday, Monday, Tuesday.
const scenario = fixtureScenarios()[0]!;
const ENTRY = scenario.entry.atMs;
const LESSON = scenario.lessonMoment.atMs;

/** A bar 1,200 px wide at x = 100, so one pixel is six simulated minutes. */
const RECT = { left: 100, top: 0, width: 1200, height: 40 };
const xAt = (t: SimMs) => RECT.left + (t / WEEK_MS) * RECT.width;

// Testing Library's async wrapper (which user-event runs through) drains with a setTimeout(0) and
// advances only Jest's fake timers, so under Vitest's it would wait forever. Point it at Vitest's.
const withJest = globalThis as { jest?: { advanceTimersByTime: (ms: number) => void } };
beforeEach(() => {
  vi.useFakeTimers();
  withJest.jest = { advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms) };
});
afterEach(() => {
  delete withJest.jest;
  vi.useRealTimers();
});

function setup({ load = true } = {}) {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const store = createFixturePlaybackStore({
    clock,
    frames: clock,
    fake: { schedule: queue.schedule },
  });
  if (load) store.loadScenario(scenario);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const view = render(<WeekTimeline store={store} />);
  const slider = screen.getByRole('slider', { name: 'Simulated time' });
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
    ...RECT,
    x: RECT.left,
    y: RECT.top,
    right: RECT.left + RECT.width,
    bottom: RECT.top + RECT.height,
    toJSON: () => RECT,
  });
  const part = (name: string) =>
    view.container.querySelectorAll<HTMLElement>(`[data-part="${name}"]`);
  const playhead = () => part('playhead')[0]!;
  /** Lets the throttled selectors deliver their trailing update. */
  const flush = () =>
    act(() => {
      vi.advanceTimersByTime(300);
    });
  /** Runs the fake engine until [fromMs, toMs) is computed. */
  const compute = (fromMs: SimMs, toMs: SimMs) => {
    act(() => queue.runUntil(() => coversRange(store.getState().computed, fromMs, toMs)));
    flush();
  };
  const computeAll = () => {
    act(() => {
      queue.runAll();
    });
    flush();
  };
  /** Runs n frames of dtMs, keeping the store's clock and React's timers in step. */
  const frames = (n: number, dtMs = 16) => {
    for (let i = 0; i < n; i++) {
      act(() => {
        clock.frame(dtMs);
        vi.advanceTimersByTime(dtMs);
      });
    }
  };
  const t = () => store.getState().playheadMs;
  return {
    store,
    queue,
    clock,
    user,
    view,
    slider,
    part,
    playhead,
    flush,
    compute,
    computeAll,
    frames,
    t,
  };
}

describe('rendering from store state', () => {
  it('shows the five days, shaded off-shift hours, and the lesson moment', () => {
    const { part, playhead } = setup();
    expect([...part('day-label')].map((el) => el.textContent)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
    ]);
    expect(part('day-label')[2]).toHaveAttribute('data-current', 'true');
    const nights = [...part('off-shift')].map((el) => [el.style.left, el.style.width]);
    expect(nights).toEqual(
      offShiftSpans(scenario.sim.shift).map((s) => [
        leftPercent(s.fromMs),
        widthPercent(s.fromMs, s.toMs),
      ]),
    );
    expect(nights).toHaveLength(6);
    expect(part('day-divider')).toHaveLength(4);

    const lesson = screen.getByRole('button', { name: 'Lesson moment, Wednesday 10:30' });
    expect(lesson).toHaveStyle({ left: leftPercent(LESSON) });
    expect(lesson.querySelector('[data-glyph="triangle"]')).not.toBeNull();
    expect(part('lesson-band')[0]).toHaveStyle({ left: leftPercent(LESSON) });
    expect(playhead()).toBeVisible();
    expect(playhead().style.left).toBe(leftPercent(ENTRY));
  });

  it('draws computed ranges as the engine reports them, days out of order', () => {
    const { part, compute, computeAll, slider } = setup();
    expect(part('computed-range')).toHaveLength(0);

    // The entry day comes first, then the days after it, then Monday.
    compute(simMs(2, 0), WEEK_MS);
    compute(simMs(0, 0), simMs(0, 6));
    const ranges = [...part('computed-range')];
    expect(ranges.map((el) => Number(el.dataset.from))).toEqual([0, simMs(2, 0)]);
    expect(Number(ranges[1]!.dataset.to)).toBe(WEEK_MS);
    expect(ranges[1]).toHaveStyle({
      left: leftPercent(simMs(2, 0)),
      width: widthPercent(simMs(2, 0), WEEK_MS),
    });
    expect(Number(ranges[0]!.dataset.to)).toBeLessThan(simMs(1, 0));
    expect(slider).toHaveAccessibleDescription(
      expect.stringMatching(
        /^Computed: Monday 00:00 to Monday \d\d:\d\d; Wednesday 00:00 to end of Friday\.$/,
      ),
    );

    computeAll();
    expect([...part('computed-range')].map((el) => [el.dataset.from, el.dataset.to])).toEqual([
      ['0', String(WEEK_MS)],
    ]);
    expect(slider).toHaveAccessibleDescription('Computed: Monday 00:00 to end of Friday.');
  });

  it('adds a fork marker with a flag, labelled on focus', () => {
    const { store, part, flush, compute } = setup();
    compute(ENTRY, ENTRY + HOUR_MS);
    act(() => store.fork({ kind: 'set', atMs: 0, changes: { loadMultiplier: 1.5 } }, 'Load 1.5×'));
    flush();

    const fork = screen.getByRole('button', { name: 'Fork at Wednesday 10:28' });
    expect(fork).toHaveStyle({ left: leftPercent(ENTRY) });
    expect(fork.querySelector('[data-glyph="flag"]')).not.toBeNull();
    expect(part('fork-line')[0]).toHaveStyle({ left: leftPercent(ENTRY) });

    act(() => fork.focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toBeVisible();
    expect(tip).toHaveTextContent('Fork · Wednesday 10:28');
    expect(tip).toHaveTextContent('Load 1.5×');
    expect(fork).toHaveAccessibleDescription(expect.stringContaining('Load 1.5×'));
  });

  it('labels the lesson moment on hover and on focus, and seeks there on click', async () => {
    const { user, t } = setup();
    const lesson = screen.getByRole('button', { name: /^Lesson moment/ });
    const tip = () => screen.getByRole('tooltip', { hidden: true });
    expect(tip()).not.toBeVisible();

    await user.hover(lesson);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tip()).toBeVisible();
    expect(tip()).toHaveTextContent(scenario.lessonMoment.label);
    await user.unhover(lesson);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(tip()).not.toBeVisible();

    act(() => lesson.focus());
    expect(tip()).toBeVisible();
    expect(tip()).toHaveTextContent('Lesson moment · Wednesday 10:30');

    await user.click(lesson);
    expect(t()).toBe(LESSON);
  });

  it('shows a buffering indicator while the playhead waits for uncomputed time', () => {
    const { store, playhead, compute, frames, flush, t } = setup();
    // Nothing is computed yet, so the entry point itself is waiting.
    expect(screen.getByRole('status')).toHaveTextContent('Computing…');
    expect(playhead()).toHaveAttribute('data-buffering', 'true');

    compute(ENTRY, ENTRY + MINUTE_MS);
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(playhead()).not.toHaveAttribute('data-buffering');

    // Play into the edge of the computed range, with the engine paused.
    const edge = store.getState().computed.find((r) => r.fromMs <= ENTRY && ENTRY < r.toMs)!.toMs;
    act(() => {
      store.setSpeed(1000);
      store.play();
    });
    frames(Math.ceil((edge - ENTRY) / 1000 / 100) + 2, 100);
    flush();
    expect(t()).toBe(edge);
    expect(store.getState()).toMatchObject({ buffering: true, playing: true });
    expect(screen.getByRole('status')).toHaveTextContent('Computing…');
    expect(playhead()).toHaveAttribute('data-buffering', 'true');
    expect(playhead().style.left).toBe(leftPercent(edge));
  });

  it('marks rollup arrivals only in High-side mode', () => {
    const { store, part, flush } = setup();
    expect(part('rollup-tick')).toHaveLength(0);
    act(() => store.setMode('highSide'));
    flush();
    expect([...part('rollup-tick')].map((el) => el.style.left)).toEqual(
      [1, 2, 3, 4].map((d) => leftPercent(d * DAY_MS + 12 * HOUR_MS)),
    );
  });
});

describe('without data', () => {
  it('renders before a scenario loads, ignores input, then picks the scenario up', async () => {
    const { store, user, slider, part, playhead, flush, t } = setup({ load: false });
    const seek = vi.spyOn(store, 'seek');
    expect(part('day-label')).toHaveLength(5);
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('aria-valuetext', 'No scenario loaded');
    expect(part('off-shift')).toHaveLength(0);
    expect(part('computed-range')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
    expect(playhead()).not.toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('');

    act(() => slider.focus());
    await user.keyboard('{ArrowRight}{PageUp}{End}');
    await user.pointer({
      keys: '[MouseLeft]',
      target: slider,
      coords: { clientX: xAt(simMs(3, 9)) },
    });
    expect(seek).not.toHaveBeenCalled();
    expect(t()).toBe(0);

    act(() => store.loadScenario(scenario));
    flush();
    expect(slider).not.toHaveAttribute('aria-disabled');
    expect(slider).toHaveAttribute('aria-valuetext', 'Wednesday 10:28');
    expect(screen.getByRole('button', { name: /^Lesson moment/ })).toBeInTheDocument();
    expect(part('off-shift')).toHaveLength(6);
    expect(playhead()).toBeVisible();
  });

  it('renders with zero computed ranges', () => {
    const { part, slider } = setup();
    expect(part('computed-range')).toHaveLength(0);
    expect(slider).toHaveAccessibleDescription('Nothing computed yet.');
    expect(slider).toHaveAttribute('aria-valuetext', 'Wednesday 10:28');
  });
});

describe('pointer scrubbing', () => {
  it('seeks to the time under a click', async () => {
    const { user, slider, t } = setup();
    await user.pointer({
      keys: '[MouseLeft]',
      target: slider,
      coords: { clientX: xAt(simMs(3, 9)) },
    });
    expect(t()).toBeCloseTo(simMs(3, 9), -1);
    expect(slider).toHaveFocus();
  });

  it('snaps a click in the night to the nearer shift edge, and clamps past the ends', async () => {
    const { user, slider, t } = setup();
    const click = (clientX: number) =>
      user.pointer({ keys: '[MouseLeft]', target: slider, coords: { clientX } });
    await click(xAt(simMs(1, 20)));
    expect(t()).toBe(simMs(1, 17));
    await click(xAt(simMs(2, 4)));
    expect(t()).toBe(simMs(2, 7));
    await click(RECT.left - 50);
    expect(t()).toBe(simMs(0, 7));
    await click(RECT.left + RECT.width + 50);
    expect(t()).toBe(simMs(4, 17));
  });

  it('drags the playhead and stops on release', async () => {
    const { user, slider, t } = setup();
    await user.pointer({
      keys: '[MouseLeft>]',
      target: slider,
      coords: { clientX: xAt(simMs(1, 9)) },
    });
    expect(t()).toBeCloseTo(simMs(1, 9), -1);
    await user.pointer({ target: slider, coords: { clientX: xAt(simMs(1, 12)) } });
    expect(t()).toBeCloseTo(simMs(1, 12), -1);
    await user.pointer({ target: slider, coords: { clientX: xAt(simMs(3, 15)) } });
    expect(t()).toBeCloseTo(simMs(3, 15), -1);
    await user.pointer({ keys: '[/MouseLeft]', target: slider });
    await user.pointer({ target: slider, coords: { clientX: xAt(simMs(4, 10)) } });
    expect(t()).toBeCloseTo(simMs(3, 15), -1);
  });

  it('ignores buttons other than the primary', async () => {
    const { user, slider, t } = setup();
    await user.pointer({
      keys: '[MouseRight]',
      target: slider,
      coords: { clientX: xAt(simMs(3, 9)) },
    });
    expect(t()).toBe(ENTRY);
  });

  it('keeps playing from the new time when scrubbed while playing', async () => {
    const { store, user, slider, computeAll, frames, t } = setup();
    computeAll();
    act(() => store.play());
    frames(1, 100);
    expect(t()).toBe(ENTRY + 500);
    await user.pointer({
      keys: '[MouseLeft]',
      target: slider,
      coords: { clientX: xAt(simMs(3, 9)) },
    });
    const landed = t();
    expect(landed).toBeCloseTo(simMs(3, 9), -1);
    frames(1, 100);
    expect(store.getState().playing).toBe(true);
    expect(t()).toBeCloseTo(landed + 500, 6);
  });
});

describe('keyboard', () => {
  it('is a slider over the playable week with day-and-time aria-valuetext', () => {
    const { slider } = setup();
    expect(slider).toHaveAttribute('tabindex', '0');
    expect(slider).toHaveAttribute('aria-valuemin', String(simMs(0, 7)));
    expect(slider).toHaveAttribute('aria-valuemax', String(simMs(4, 17)));
    expect(slider).toHaveAttribute('aria-valuenow', String(ENTRY));
    expect(slider).toHaveAttribute('aria-valuetext', 'Wednesday 10:28');
  });

  it.each([
    ['{ArrowRight}', ENTRY + MINUTE_MS, 'Wednesday 10:29'],
    ['{ArrowUp}', ENTRY + MINUTE_MS, 'Wednesday 10:29'],
    ['{ArrowLeft}', ENTRY - MINUTE_MS, 'Wednesday 10:27'],
    ['{ArrowDown}', ENTRY - MINUTE_MS, 'Wednesday 10:27'],
    ['{Shift>}{ArrowRight}{/Shift}', ENTRY + HOUR_MS, 'Wednesday 11:28'],
    ['{Shift>}{ArrowUp}{/Shift}', ENTRY + HOUR_MS, 'Wednesday 11:28'],
    ['{Shift>}{ArrowLeft}{/Shift}', ENTRY - HOUR_MS, 'Wednesday 09:28'],
    ['{Shift>}{ArrowDown}{/Shift}', ENTRY - HOUR_MS, 'Wednesday 09:28'],
    ['{PageUp}', ENTRY + DAY_MS, 'Thursday 10:28'],
    ['{PageDown}', ENTRY - DAY_MS, 'Tuesday 10:28'],
    ['{Home}', simMs(0, 7), 'Monday 07:00'],
    ['{End}', simMs(4, 17), 'Friday 17:00'],
  ])('%s moves the playhead', async (keys, expected, text) => {
    const { user, slider, flush, t } = setup();
    act(() => slider.focus());
    await user.keyboard(keys);
    expect(t()).toBe(expected);
    flush();
    expect(slider).toHaveAttribute('aria-valuetext', text);
    expect(slider).toHaveAttribute('aria-valuenow', String(expected));
    expect(screen.getByText(text, { selector: '[data-part="readout"]' })).toBeInTheDocument();
  });

  it('steps across nights instead of into them', async () => {
    const { store, user, slider, flush, t } = setup();
    act(() => store.seek(simMs(2, 16, 59)));
    act(() => slider.focus());
    await user.keyboard('{ArrowRight}');
    expect(t()).toBe(simMs(3, 7));
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(t()).toBe(simMs(2, 16, 58));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(t()).toBe(simMs(3, 7, 58));
    flush();
    expect(slider).toHaveAttribute('aria-valuetext', 'Thursday 07:58');
  });

  it('ignores other keys and modified arrows', async () => {
    const { user, slider, t } = setup();
    act(() => slider.focus());
    await user.keyboard('a{Enter}{Control>}{ArrowRight}{/Control}{Alt>}{ArrowLeft}{/Alt}');
    await user.keyboard('{Meta>}{End}{/Meta}');
    expect(t()).toBe(ENTRY);
  });

  it('keeps playing after a key step', async () => {
    const { store, user, slider, computeAll, frames, t } = setup();
    computeAll();
    act(() => {
      store.play();
      slider.focus();
    });
    await user.keyboard('{PageUp}');
    expect(t()).toBe(ENTRY + DAY_MS);
    frames(1, 100);
    expect(store.getState().playing).toBe(true);
    expect(t()).toBe(ENTRY + DAY_MS + 500);
  });
});

describe('playhead', () => {
  it('follows playback every frame without re-rendering the bar', () => {
    const { store, computeAll, frames, playhead, t } = setup();
    computeAll();
    let commits = 0;
    const { unmount } = render(
      <Profiler id="timeline" onRender={() => commits++}>
        <WeekTimeline store={store} />
      </Profiler>,
    );
    const second = document.querySelectorAll<HTMLElement>('[data-part="playhead"]')[1]!;
    act(() => {
      store.setSpeed(1000);
      store.play();
    });
    commits = 0;
    const lefts = new Set<string>();
    for (let i = 0; i < 60; i++) {
      frames(1);
      expect(playhead().style.left).toBe(leftPercent(t()));
      expect(second.style.left).toBe(leftPercent(t()));
      lefts.add(second.style.left);
    }
    // 60 frames at 1000× cover 16 simulated minutes: the playhead moved every frame, while React
    // re-rendered only for the minute readout, at most TIMELINE_CLOCK_HZ times a second.
    expect(lefts.size).toBe(60);
    expect(t()).toBe(ENTRY + 60 * 16 * 1000);
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(10);
    unmount();
  });

  it('jumps with seeks, jumpToEntry, and reset', () => {
    const { store, clock, playhead } = setup();
    act(() => store.seek(simMs(1, 9)));
    expect(playhead().style.left).toBe(leftPercent(ENTRY)); // positioned on the next frame
    act(() => clock.frame());
    expect(playhead().style.left).toBe(leftPercent(simMs(1, 9)));
    act(() => {
      store.jumpToEntry();
      clock.frame();
    });
    expect(playhead().style.left).toBe(leftPercent(ENTRY));
    act(() => {
      store.seek(simMs(4, 9));
      store.reset();
      clock.frame();
    });
    expect(playhead().style.left).toBe(leftPercent(ENTRY));
  });

  it('shows the playhead day and time in the readout', () => {
    const { store, flush, view } = setup();
    const readout = view.container.querySelector('[data-part="readout"]')!;
    expect(readout).toHaveTextContent('Wednesday 10:28');
    act(() => store.seek(simMs(3, 14, 5, 30)));
    flush();
    expect(readout).toHaveTextContent('Thursday 14:05');
    expect(
      within(view.container).getAllByText('Thursday', { selector: '[data-part="day-label"]' })[0],
    ).toHaveAttribute('data-current', 'true');
  });
});
