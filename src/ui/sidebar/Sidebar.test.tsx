import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibration } from '../../data/calibration.ts';
import type { Calibration } from '../../engine/calibration.ts';
import type { Mode } from '../../playback/types.ts';
import { createTestStore, testScenarios, type TestStore } from '../chrome/testing.tsx';
import { footnoteText } from './footnote.ts';
import { Sidebar } from './Sidebar.tsx';

const measured: Calibration = { ...calibration, status: 'measured' };

let current: TestStore | null = null;
afterEach(() => {
  current?.store.dispose();
  current = null;
});

function setup(mode: Mode = 'live', tab = 0, cal: Calibration = calibration) {
  current = createTestStore();
  const scenario = testScenarios()[tab]!;
  current.store.loadScenario(scenario);
  const onShowIntro = vi.fn();
  render(
    <Sidebar
      store={current.store}
      scenario={scenario}
      mode={mode}
      calibration={cal}
      rollup={<table aria-label="Rollup" />}
      onShowIntro={onShowIntro}
    />,
  );
  return { scenario, onShowIntro };
}

describe('Sidebar', () => {
  it('shows the tab and its placeholder copy: what to watch and try this', () => {
    const { scenario } = setup();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Inference Simulator');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('1 · Long prompt');
    const watch = screen.getByRole('region', { name: 'What to watch' });
    expect(watch).toHaveTextContent(scenario.copy.whatToWatch[0]!);
    expect(watch).toHaveTextContent('TODO(copy)');
    const tryThis = screen.getByRole('region', { name: 'Try this' });
    expect(
      within(tryThis)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(scenario.copy.tryThis);
  });

  it('boxes the lesson under the title when the scenario has one', () => {
    current = createTestStore();
    const base = testScenarios()[0]!;
    const lesson = { summary: 'What the tab shows.', takeaway: 'What to remember.' };
    render(
      <Sidebar
        store={current.store}
        scenario={{ ...base, lesson }}
        mode="live"
        calibration={calibration}
      />,
    );
    const box = screen.getByRole('region', { name: 'The lesson' });
    expect(box).toHaveTextContent(lesson.summary);
    expect(box).toHaveTextContent(lesson.takeaway);
  });

  it('shows the live status line in Live mode, not the rollup', () => {
    setup('live');
    const status = screen.getByRole('region', { name: 'Live status' });
    expect(status.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole('table', { name: 'Rollup' })).toBeNull();
  });

  it('on the High side, hides the status line and shows the collapsible rollup', async () => {
    const user = userEvent.setup();
    setup('highSide');
    expect(screen.queryByRole('region', { name: 'Live status' })).toBeNull();
    expect(document.querySelector('[aria-live]')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Daily rollup' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('table', { name: 'Rollup' })).toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: 'Rollup' })).toBeNull();
  });

  it('reopens the intro from About', async () => {
    const user = userEvent.setup();
    const { onShowIntro } = setup();
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(onShowIntro).toHaveBeenCalledOnce();
  });

  it('says so in the footnote while the calibration is provisional', () => {
    setup('live', 0, calibration);
    expect(calibration.status).toBe('provisional');
    const footer = screen.getByRole('contentinfo', { hidden: true });
    expect(footer).toHaveTextContent('Provisional calibration');
    expect(footer).toHaveTextContent(/spec-sheet estimates for Llama 3\.1 8B Instruct/);
    expect(footer).toHaveTextContent(/no accuracy claim/);
  });

  it('drops the provisional wording once the calibration is measured', () => {
    setup('live', 0, measured);
    const footer = screen.getByRole('contentinfo', { hidden: true });
    expect(footer).not.toHaveTextContent(/provisional/i);
    expect(footer).toHaveTextContent(
      'Calibrated from vLLM 0.20.1 benchmarks of Llama 3.1 8B Instruct on NVIDIA A100 PCIe 40GB GPUs.',
    );
    expect(footer).toHaveTextContent(/no accuracy claim/);
  });

  it('names an extrapolated preset in the footnote and under the title', () => {
    setup('live', 4);
    expect(screen.getByText('Server B · 8 replicas · Extrapolated')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { hidden: true })).toHaveTextContent(
      'Server B (8 replicas) is extrapolated from per-replica measurements.',
    );
  });
});

describe('footnoteText', () => {
  it('has the basis and no accuracy claim in both states', () => {
    for (const cal of [calibration, measured]) {
      const { lines } = footnoteText(cal);
      expect(lines.join(' ')).toMatch(/Llama 3\.1 8B Instruct on NVIDIA A100 PCIe 40GB/);
      expect(lines.at(-1)).toMatch(/absolute numbers do not.*no accuracy claim/);
    }
    expect(footnoteText(calibration).provisional).toBe(true);
    expect(footnoteText(measured).provisional).toBe(false);
  });
});
