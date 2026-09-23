import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { simMs } from '../../engine/time.ts';
import { EXTRAPOLATED_TOOLTIP } from './ScenarioTabs.tsx';
import { ChromeHarness, createTestStore, testScenarios, type TestStore } from './testing.tsx';

let current: TestStore | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
});

function setup(scenarios = testScenarios()) {
  current = createTestStore();
  render(<ChromeHarness store={current.store} scenarios={scenarios} />);
  return { ...current, user: userEvent.setup(), state: () => current!.store.getState() };
}

const tabs = () => screen.getAllByRole('tab');

describe('ScenarioTabs', () => {
  it('shows six tabs in teaching order with number, title, and preset', () => {
    // Given out of order, they still read 1 to 6.
    setup(testScenarios().reverse());
    expect(screen.getByRole('tablist', { name: 'Lessons' })).toBeInTheDocument();
    expect(tabs().map((t) => t.textContent)).toEqual([
      '1 Long prompt, 1 GPU',
      '2 Saturation knee, 1 GPU',
      '3 KV exhaustion, 1 GPU',
      '4 Routing, 2 replicas',
      '5 Fail and recover, Server B · 8 replicas Extrapolated',
      '6 Retry storm, Server A · 4 replicas Extrapolated',
    ]);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('labels only the extrapolated presets, with an orientational tooltip', async () => {
    const { user } = setup();
    const badged = tabs().filter((t) => within(t).queryByText('Extrapolated'));
    expect(badged.map((t) => t.id)).toEqual(['lesson-tab-fail-recover', 'lesson-tab-retry-storm']);
    await user.hover(within(badged[0]!).getByText('Extrapolated'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(EXTRAPOLATED_TOOLTIP);
  });

  it('uses manual activation: arrows move focus, Enter selects', async () => {
    const { user, state } = setup();
    await user.click(tabs()[0]!);
    await user.keyboard('{ArrowRight}');
    expect(tabs()[1]).toHaveFocus();
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
    expect(state().scenarioId).toBe('long-prompt');
    await user.keyboard('{Enter}');
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(state().scenarioId).toBe('knee'));
  });

  it('loads the selected tab fresh and discards the old run (K16)', async () => {
    const { user, state, store } = setup();
    const [tab1, tab2] = testScenarios();
    act(() => {
      store.seek(simMs(2, 12));
      store.fork({ kind: 'set', atMs: 0, changes: { loadMultiplier: 2 } }, 'Load: 2.0×');
    });
    const firstRun = state().runId;
    expect(state().forks).toHaveLength(1);

    await user.click(tabs()[1]!);
    await waitFor(() => expect(state().scenarioId).toBe(tab2!.id));
    expect(state()).toMatchObject({
      runId: firstRun + 1,
      forks: [],
      playheadMs: tab2!.entry.atMs,
      playing: false,
    });

    await user.click(tabs()[0]!);
    await waitFor(() => expect(state().scenarioId).toBe(tab1!.id));
    expect(state()).toMatchObject({ runId: firstRun + 2, forks: [], playheadMs: tab1!.entry.atMs });
    // The panel follows the selected tab.
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs()[0]!.id);
  });
});
