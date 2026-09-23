import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RollupRow } from '../engine/results.ts';
import { rollupDeliveryMs, type DayIndex } from '../engine/time.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import { BAR_MAX_PX, DailyBars, layoutBars } from './DailyBars.tsx';
import { NOT_COLLECTED_MESSAGE, NotCollectedPanel } from './NotCollectedPanel.tsx';

function rows(replicas: number, days: number): RollupRow[] {
  return createFakeIndex({ replicas })
    .rollup()
    .filter((r) => r.day < days);
}

describe('DailyBars', () => {
  it('draws one bar per replica per delivered day, at most 24 px wide, grouped by day', () => {
    const r = rows(8, 3);
    const bars = layoutBars(r, 'meanE2eMs', 8, 900);
    expect(bars).toHaveLength(24);
    for (const b of bars) expect(b.width).toBeLessThanOrEqual(BAR_MAX_PX);
    // Day groups don't overlap, and replicas sit in order inside a day.
    expect(bars[7]!.x + bars[7]!.width).toBeLessThan(bars[8]!.x);
    expect(bars[1]!.x).toBeGreaterThan(bars[0]!.x);
  });

  it('skips days with nothing served (NaN mean) and grows bars with progress', () => {
    const r = rows(1, 2);
    r[1] = { ...r[1]!, meanE2eMs: NaN, requestsServed: 0 };
    const { container, rerender } = render(
      <DailyBars rows={r} metric="meanE2eMs" replicas={1} width={960} height={120} progress={0} />,
    );
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(1);
    expect(container.querySelector('[data-bar]')!.getAttribute('d')).toBe('');
    rerender(
      <DailyBars rows={r} metric="meanE2eMs" replicas={1} width={960} height={120} progress={1} />,
    );
    expect(container.querySelector('[data-bar]')!.getAttribute('d')).not.toBe('');
  });

  it('outlines pending days with when they arrive', () => {
    const { container } = render(
      <DailyBars
        rows={rows(2, 1)}
        metric="meanNvidiaSmiUtil"
        replicas={2}
        width={960}
        height={120}
        pendingDays={[1, 2] as DayIndex[]}
      />,
    );
    expect(container.querySelectorAll('[data-pending-day]')).toHaveLength(2);
    expect(screen.getByText('Arrives Wed 12:00')).toBeInTheDocument();
    expect(rollupDeliveryMs(1)).toBeGreaterThan(0);
  });

  it('reads bars from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <DailyBars
        rows={rows(2, 2)}
        metric="requestsServed"
        replicas={2}
        width={960}
        height={120}
        title="Served"
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('group', { name: /Served: 4 daily bars/ })).toHaveFocus();
    expect(screen.getByText(/^Mon R1: [\d,]+, [\d,]+ served$/)).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(screen.getByText(/^Tue R2: /)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/^Tue R2: /)).toBeNull();
  });
});

describe('NotCollectedPanel', () => {
  it('says the metric is not collected, under the chart title', () => {
    render(<NotCollectedPanel title="KV cache" height={120} />);
    expect(screen.getByText(NOT_COLLECTED_MESSAGE)).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: `KV cache: ${NOT_COLLECTED_MESSAGE}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(NOT_COLLECTED_MESSAGE).parentElement).toHaveClass('bg-hatch');
  });
});
