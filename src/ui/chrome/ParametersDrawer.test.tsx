import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINUTE_MS } from '../../engine/time.ts';
import { ChromeHarness, createTestStore, testScenarios, type TestStore } from './testing.tsx';

let current: TestStore | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
});

/** Opens tab 4 (select, range, toggle, and ms-range controls; a baseline Load patch) and its drawer. */
async function setup() {
  current = createTestStore();
  const { store } = current;
  const fork = vi.spyOn(store, 'fork');
  const user = userEvent.setup();
  render(<ChromeHarness store={store} scenarios={testScenarios()} />);
  await user.click(screen.getByRole('tab', { name: /^4 Routing/ }));
  await waitFor(() => expect(store.getState().scenarioId).toBe('routing'));
  const toggle = screen.getByRole('button', { name: /parameters/i });
  await user.click(toggle);
  const drawer = await screen.findByRole('region', { name: 'Parameters' });
  return { ...current, fork, user, toggle, drawer, state: () => store.getState() };
}

const routing = testScenarios()[3]!;
const slider = (name: string) => screen.getByRole('slider', { name });

describe('ParametersDrawer', () => {
  it('opens under the toolbar from its toggle and closes with Escape', async () => {
    const { toggle, drawer, user } = await setup();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', drawer.id);
    expect(within(drawer).getByRole('combobox', { name: 'Routing policy' })).toBeInTheDocument();
    expect(slider('Load')).toBeInTheDocument();
    expect(
      within(drawer).getByRole('switch', { name: 'Admission control' }),
    ).toHaveAccessibleDescription('Caps outstanding requests per Ready replica.');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
  });

  it('forks once per select change, as a set patch at the playhead', async () => {
    const { fork, user, state } = await setup();
    const select = screen.getByRole('combobox', { name: 'Routing policy' });
    expect(select).toHaveDisplayValue('Round-robin');
    await user.selectOptions(select, 'Session affinity');
    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(
      { kind: 'set', atMs: state().playheadMs, changes: { routingPolicy: 'sessionAffinity' } },
      'Routing policy: Session affinity',
    );
    expect(state().forks.map((f) => f.label)).toEqual(['Routing policy: Session affinity']);
    await waitFor(() => expect(select).toHaveDisplayValue('Session affinity'));
  });

  it('commits a range slider on pointer release, not on every step', async () => {
    const { fork } = await setup();
    const load = slider('Load');
    fireEvent.pointerDown(load);
    for (const v of ['1.1', '1.2', '1.3']) fireEvent.change(load, { target: { value: v } });
    expect(fork).not.toHaveBeenCalled();
    expect(load).toHaveAttribute('aria-valuetext', '1.3×');
    fireEvent.pointerUp(load);
    expect(fork).toHaveBeenCalledOnce();
    expect(fork.mock.calls[0]![1]).toBe('Load: 1.3×');
    expect(fork.mock.calls[0]![0]).toMatchObject({ kind: 'set', changes: { loadMultiplier: 1.3 } });
    await waitFor(() => expect(load).toHaveValue('1.3'));
    fireEvent.blur(load);
    expect(fork).toHaveBeenCalledOnce();
  });

  it('commits when the pointer is released outside the slider', async () => {
    const { fork } = await setup();
    const load = slider('Load');
    fireEvent.pointerDown(load);
    fireEvent.change(load, { target: { value: '0.7' } });
    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(fork).toHaveBeenCalledOnce();
    expect(fork.mock.calls[0]![1]).toBe('Load: 0.7×');
  });

  it('commits keyboard steps on key up', async () => {
    const { fork } = await setup();
    const timeout = slider('Client timeout');
    expect(timeout).toHaveAttribute('aria-valuetext', '60 s');
    fireEvent.keyDown(timeout, { key: 'ArrowRight' });
    fireEvent.change(timeout, { target: { value: '65000' } });
    fireEvent.keyUp(timeout, { key: 'ArrowRight' });
    expect(fork).toHaveBeenCalledOnce();
    expect(fork.mock.calls[0]![1]).toBe('Client timeout: 65 s');
  });

  it('does not fork when a slider is released at its current value', async () => {
    const { fork } = await setup();
    const load = slider('Load');
    fireEvent.change(load, { target: { value: '1.4' } });
    fireEvent.change(load, { target: { value: '1' } });
    fireEvent.pointerUp(load);
    fireEvent.keyUp(load, { key: 'Tab' });
    expect(fork).not.toHaveBeenCalled();
  });

  it('forks a toggle change', async () => {
    const { fork, user } = await setup();
    const admission = screen.getByRole('switch', { name: 'Admission control' });
    expect(admission).toHaveAttribute('aria-checked', 'false');
    await user.click(admission);
    expect(fork).toHaveBeenCalledOnce();
    expect(fork.mock.calls[0]![0]).toMatchObject({
      kind: 'set',
      changes: { admissionLimitPerReplica: 8 },
    });
    expect(fork.mock.calls[0]![1]).toBe('Admission control: On');
    await waitFor(() => expect(admission).toHaveAttribute('aria-checked', 'true'));
  });

  it('shows the values in effect at the playhead: baseline patches and this run’s forks', async () => {
    const { store, user } = await setup();
    const load = slider('Load');
    const moment = routing.lessonMoment.atMs;
    // Before the lesson moment: the scenario's starting value.
    expect(load).toHaveAttribute('aria-valuetext', '1.0×');
    // After it: the baseline patch.
    act(() => store.seek(moment + MINUTE_MS));
    await waitFor(() => expect(load).toHaveAttribute('aria-valuetext', '1.5×'));

    // A fork later on applies from its own time.
    act(() => store.seek(moment + 10 * MINUTE_MS));
    fireEvent.change(load, { target: { value: '1.8' } });
    fireEvent.pointerUp(load);
    await waitFor(() => expect(load).toHaveAttribute('aria-valuetext', '1.8×'));
    act(() => store.seek(moment + 5 * MINUTE_MS));
    await waitFor(() => expect(load).toHaveAttribute('aria-valuetext', '1.5×'));

    // Reset discards the fork.
    act(() => store.seek(moment + 20 * MINUTE_MS));
    await waitFor(() => expect(load).toHaveAttribute('aria-valuetext', '1.8×'));
    await user.click(screen.getByRole('button', { name: /^reset\b/i }));
    act(() => store.seek(moment + 20 * MINUTE_MS));
    await waitFor(() => expect(load).toHaveAttribute('aria-valuetext', '1.5×'));
  });
});
