import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchAt } from '../../engine/api.ts';
import { simMs } from '../../engine/time.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import { ChromeHarness, createTestStore, testScenarios, type TestStore } from './testing.tsx';

let current: TestStore | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
});

function setup(scenarios: Scenario[] = testScenarios()) {
  current = createTestStore();
  const fork = vi.spyOn(current.store, 'fork');
  render(<ChromeHarness store={current.store} scenarios={scenarios} />);
  return { ...current, fork, user: userEvent.setup(), state: () => current!.store.getState() };
}

const playback = () => screen.getByRole('group', { name: 'Playback' });
const scenarioRow = () => screen.getByRole('group', { name: 'Scenario' });

describe('Toolbar', () => {
  it('plays and pauses, and the button says which', async () => {
    const { user, state } = setup();
    expect(state()).toMatchObject({ scenarioId: 'long-prompt', playing: false });
    await user.click(screen.getByRole('button', { name: /^play\b/i }));
    expect(state().playing).toBe(true);
    const pause = await screen.findByRole('button', { name: /^pause\b/i });
    await user.click(pause);
    expect(state().playing).toBe(false);
    expect(await screen.findByRole('button', { name: /^play\b/i })).toBe(pause);
  });

  it('forks the trigger at the playhead with the scenario label', async () => {
    const { user, state, fork, store } = setup();
    const scenario = testScenarios()[0]!;
    const at = simMs(2, 11, 15);
    act(() => store.seek(at));
    await user.click(within(scenarioRow()).getByRole('button', { name: scenario.trigger.label }));
    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(patchAt(scenario.trigger.patch, at), scenario.trigger.label);
    expect(state().forks).toEqual([{ atMs: at, revision: 1, label: scenario.trigger.label }]);
  });

  it('shows a named fix only where the scenario has one, and applies it as a set fork', async () => {
    const { user, fork, state } = setup();
    expect(within(scenarioRow()).getAllByRole('button')).toHaveLength(2); // trigger, Parameters
    await user.click(screen.getByRole('tab', { name: /^4 Routing/ }));
    await waitFor(() => expect(state().scenarioId).toBe('routing'));
    const fix = within(scenarioRow()).getByRole('button', { name: /use session affinity/i });
    const at = state().playheadMs;
    await user.click(fix);
    expect(fork).toHaveBeenCalledWith(
      { kind: 'set', atMs: at, changes: { routingPolicy: 'sessionAffinity' } },
      'Use session affinity',
    );
    // In effect from the playhead on, so the button says so.
    await waitFor(() => expect(fix).toHaveTextContent('(on)'));
  });

  it('switches between Live and High side', async () => {
    const { user, state } = setup();
    const view = screen.getByRole('radiogroup', { name: 'Telemetry view' });
    const live = within(view).getByRole('radio', { name: 'Live' });
    const high = within(view).getByRole('radio', { name: 'High side' });
    expect(live).toHaveAttribute('aria-checked', 'true');
    await user.click(high);
    expect(state().mode).toBe('highSide');
    await waitFor(() => expect(high).toHaveAttribute('aria-checked', 'true'));
    // Arrow keys move and select, like any radio group.
    await user.keyboard('{ArrowLeft}');
    expect(state().mode).toBe('live');
  });

  it('offers speed presets from 1× to 1000× and marks where dots give way to flow', async () => {
    const { user, state } = setup();
    const speed = screen.getByRole('radiogroup', { name: 'Playback speed' });
    const names = within(speed)
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(names).toEqual(['1×', '5×', '10×', '50×', '100×', '1000×']);
    expect(within(speed).getByRole('radio', { name: '5×' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const legend = () => playback().querySelector('[data-detail]');
    expect(legend()).toHaveAttribute('data-detail', 'dots');

    await user.click(within(speed).getByRole('radio', { name: '100×' }));
    expect(state().speed).toBe(100);
    await waitFor(() => expect(legend()).toHaveAttribute('data-detail', 'aggregate'));
    expect(within(speed).getByRole('radio', { name: '100×' })).toHaveAccessibleDescription(
      /aggregate flow/,
    );
    await user.click(within(speed).getByRole('radio', { name: '10×' }));
    expect(state().speed).toBe(10);
    await waitFor(() => expect(legend()).toHaveAttribute('data-detail', 'dots'));
  });

  it("adds the tab's entry speed when it isn't a preset", () => {
    const scenarios = testScenarios();
    scenarios[0] = { ...scenarios[0]!, entry: { ...scenarios[0]!.entry, speed: 20 } };
    setup(scenarios);
    const speed = screen.getByRole('radiogroup', { name: 'Playback speed' });
    expect(within(speed).getByRole('radio', { name: '20×' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('jumps back to the entry point, paused, at the entry speed', async () => {
    const { user, state, store } = setup();
    const entry = testScenarios()[0]!.entry;
    act(() => {
      store.seek(simMs(3, 14));
      store.setSpeed(1000);
      store.play();
    });
    await user.click(screen.getByRole('button', { name: 'Jump to lesson' }));
    expect(state()).toMatchObject({ playheadMs: entry.atMs, playing: false, speed: entry.speed });
  });

  it('Reset starts the tab over, discarding its forks', async () => {
    const { user, state, store } = setup();
    act(() => store.seek(simMs(2, 12)));
    await user.click(screen.getByRole('button', { name: /TODO\(copy\): trigger/ }));
    const runId = state().runId;
    expect(state().forks).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /^reset\b/i }));
    expect(state()).toMatchObject({
      runId: runId + 1,
      revision: 0,
      forks: [],
      playheadMs: testScenarios()[0]!.entry.atMs,
      scenarioId: 'long-prompt',
    });
  });

  it('shows a buffering indicator while the playhead waits for uncomputed time', async () => {
    const { queue, state, store } = setup();
    expect(state().buffering).toBe(true);
    expect(within(playback()).getByText('Computing…')).toBeInTheDocument();
    act(() => queue.runUntil(() => !store.getState().buffering));
    await waitFor(() => expect(within(playback()).queryByText('Computing…')).toBeNull());
  });

  it('shows the playhead clock and disables Play once the week is over', async () => {
    const { store } = setup();
    expect(within(playback()).getByText('Wed 10:28:00')).toBeInTheDocument();
    act(() => store.seek(simMs(4, 17, 30)));
    await waitFor(() => expect(screen.getByRole('button', { name: /^play\b/i })).toBeDisabled());
    expect(within(playback()).getByText('End of the week')).toBeInTheDocument();
  });
});
