import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { createTestStore, testScenarios, type TestStore } from './ui/chrome/testing.tsx';

let current: TestStore | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
});

function setup() {
  current = createTestStore();
  const user = userEvent.setup();
  const view = render(<App store={current.store} scenarios={testScenarios()} />);
  return { ...current, ...view, user, state: () => current!.store.getState() };
}

async function dismissIntro(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Start exploring' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('App', () => {
  it('opens on the first tab, paused at its entry point, behind the intro', async () => {
    const { user, state } = setup();
    expect(screen.getByRole('dialog', { name: 'Inference Simulator' })).toBeInTheDocument();
    expect(state()).toMatchObject({
      scenarioId: 'long-prompt',
      playing: false,
      playheadMs: testScenarios()[0]!.entry.atMs,
    });
    await dismissIntro(user);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Inference Simulator');
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    expect(screen.getByRole('button', { name: /^play\b/i })).toBeEnabled();
  });

  it('shows the intro again on every load, and from About', async () => {
    const first = setup();
    await dismissIntro(first.user);
    await first.user.click(screen.getByRole('button', { name: 'About' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    first.unmount();
    first.store.dispose();
    setup();
    expect(screen.getByRole('dialog', { name: 'Inference Simulator' })).toBeInTheDocument();
  });

  it('mounts the canvas, charts, and week timeline', async () => {
    const { user } = setup();
    await dismissIntro(user);
    const sim = screen.getByRole('region', { name: 'Simulation' });
    expect(within(sim).getByRole('img')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Charts' }).querySelector('svg')).not.toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Week timeline' })).getByRole('slider'),
    ).toBeInTheDocument();
  });

  it('switches the whole view to High side and back (05 §9)', async () => {
    const { user, container, state } = setup();
    await dismissIntro(user);
    const shell = container.querySelector('[data-mode]');
    expect(shell).toHaveAttribute('data-mode', 'live');
    expect(screen.getByRole('region', { name: 'Live status' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'High side' }));
    expect(state().mode).toBe('highSide');
    await waitFor(() => expect(shell).toHaveAttribute('data-mode', 'highSide'));
    expect(screen.queryByRole('region', { name: 'Live status' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Daily rollup' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Live' }));
    await waitFor(() => expect(shell).toHaveAttribute('data-mode', 'live'));
    expect(screen.getByRole('region', { name: 'Live status' })).toBeInTheDocument();
  });

  it("forgets a tab's parameter changes when you leave it (K16)", async () => {
    const { user, state, store } = setup();
    await dismissIntro(user);
    await user.click(screen.getByRole('tab', { name: /^4 Routing/ }));
    await waitFor(() => expect(state().scenarioId).toBe('routing'));
    await user.click(screen.getByRole('button', { name: /parameters/i }));
    const select = await screen.findByRole('combobox', { name: 'Routing policy' });
    await user.selectOptions(select, 'Session affinity');
    await waitFor(() => expect(select).toHaveDisplayValue('Session affinity'));
    expect(state().forks).toHaveLength(1);

    await user.click(screen.getByRole('tab', { name: /^1 Long prompt/ }));
    await waitFor(() => expect(state().scenarioId).toBe('long-prompt'));
    await user.click(screen.getByRole('tab', { name: /^4 Routing/ }));
    await waitFor(() => expect(state().scenarioId).toBe('routing'));
    expect(state().forks).toEqual([]);
    expect(screen.getByRole('combobox', { name: 'Routing policy' })).toHaveDisplayValue(
      'Round-robin',
    );
    // Only this run's forks count, even at the same playhead.
    act(() => store.seek(state().playheadMs));
    const load = screen.getByRole('slider', { name: 'Load' });
    fireEvent.change(load, { target: { value: '1.2' } });
    fireEvent.keyUp(load, { key: 'ArrowRight' });
    expect(state().forks.map((f) => f.label)).toEqual(['Load: 1.2×']);
  });

  it('runs keyboard shortcuts, but not behind another modal or while typing', async () => {
    const { user, state } = setup();
    // The intro is open: shortcuts are off.
    await user.keyboard(']');
    expect(state().scenarioId).toBe('long-prompt');
    await dismissIntro(user);

    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard(']'); // Only ? and Escape work in the help.
    expect(state().scenarioId).toBe('long-prompt');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.keyboard(']');
    expect(state().scenarioId).not.toBe('long-prompt');
    await user.keyboard('1');
    expect(state().scenarioId).toBe('long-prompt');
    await user.keyboard('h');
    expect(state().mode).toBe('highSide');
    await user.keyboard('h');
    const speed = state().speed;
    await user.keyboard('=');
    expect(state().speed).toBeGreaterThan(speed);
    await user.keyboard('-');
    expect(state().speed).toBe(speed);

    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard(' ');
    expect(state().playing).toBe(true);
    await user.keyboard(' ');
    expect(state().playing).toBe(false);

    await user.keyboard('t');
    expect(state().forks).toHaveLength(1);

    await user.keyboard('p');
    const load = await screen.findByRole('slider', { name: /load/i });
    load.focus();
    await user.keyboard('r'); // Typing in a field: ignored.
    expect(state().forks).toHaveLength(1);
    load.blur();
    await user.keyboard('r');
    expect(state().forks).toHaveLength(0);

    await user.keyboard('d');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts (?)' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
