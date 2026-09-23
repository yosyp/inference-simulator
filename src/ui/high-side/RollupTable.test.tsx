// The rollup table (05 §8, K17): table semantics, the metric picker, pending days, no failure
// marker and no error count, and re-rendering only when a delivery or a midnight changes it.

import { Profiler } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStaticStore } from '../../charts/test-support.ts';
import { formatCount, formatPercent } from '../../charts/format.ts';
import type { RollupRow } from '../../engine/results.ts';
import { MINUTE_MS, simMs } from '../../engine/time.ts';
import { createFakeIndex } from '../../fixtures/fake-index.ts';
import type { ResultsIndex } from '../../playback/types.ts';
import { COMPUTING, NOT_YET_REPORTED, RollupTable, formatSeconds } from './RollupTable.tsx';

function withRows(base: ResultsIndex, rows: readonly RollupRow[]): ResultsIndex {
  return Object.create(base, { rollup: { value: () => rows } }) as ResultsIndex;
}

function setup(opts: { replicas?: number; playheadMs: number; rows?: readonly RollupRow[] }) {
  const fake = createFakeIndex({ replicas: opts.replicas ?? 8 });
  const index = opts.rows ? withRows(fake, opts.rows) : fake;
  const store = createStaticStore(index, { playheadMs: opts.playheadMs, mode: 'highSide' });
  let renders = 0;
  const view = render(
    <Profiler id="table" onRender={() => renders++}>
      <RollupTable store={store} maxHz={Infinity} />
    </Profiler>,
  );
  const table = screen.getByRole('table');
  const status = (day: number) =>
    table.querySelector(`th[data-day="${day}"]`)!.getAttribute('data-status');
  const pending = (day: number) => table.querySelector<HTMLElement>(`td[data-pending="${day}"]`);
  return { store, index, table, status, pending, renders: () => renders, ...view };
}

describe('RollupTable', () => {
  it('is a table of replicas by days with headers and a caption', () => {
    const { table } = setup({ playheadMs: simMs(2, 14) });
    expect(table).toHaveAccessibleName('Requests served per replica per day');
    const cols = within(table).getAllByRole('columnheader');
    expect(cols.map((c) => c.textContent)).toEqual(['Replica', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(cols[3]).toHaveAttribute('abbr', 'Wednesday');
    expect(cols[3]).toHaveAttribute('aria-current', 'date');
    const rows = within(table).getAllByRole('rowheader');
    expect(rows.map((r) => r.textContent)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
    ]);
  });

  it('shows delivered days mid-week and leaves the current day not yet reported', () => {
    const { table, index, status, pending } = setup({ playheadMs: simMs(2, 14) });
    expect([0, 1, 2, 3, 4].map(status)).toEqual([
      'delivered',
      'delivered',
      'today',
      'future',
      'future',
    ]);
    // 8 replicas × Monday and Tuesday.
    expect(table.querySelectorAll('td[data-cell]')).toHaveLength(16);
    const r3tue = index.rollup().find((r) => r.day === 1 && r.replica === 2)!;
    expect(table.querySelector('td[data-cell="1-2"]')!.textContent).toBe(
      formatCount(r3tue.requestsServed),
    );
    // One cell down the whole column for the current day.
    const today = pending(2)!;
    expect(today).toHaveAttribute('rowspan', '8');
    expect(today.textContent).toBe(`${NOT_YET_REPORTED} Arrives Thu 12:00`);
    expect(pending(3)!.textContent).toBe('Later this week');
    expect(table.querySelector('td[data-cell^="2-"]')).toBeNull();
  });

  it('shows nothing delivered before Tuesday 12:00, and Monday arriving then', () => {
    const { status, pending, table, store } = setup({ playheadMs: simMs(1, 10) });
    expect(status(0)).toBe('awaiting');
    expect(pending(0)!.textContent).toBe('Arrives Tue 12:00');
    expect(status(1)).toBe('today');
    expect(table.querySelectorAll('td[data-cell]')).toHaveLength(0);
    act(() => store.set({ playheadMs: simMs(1, 12) }));
    expect(status(0)).toBe('delivered');
    expect(table.querySelectorAll('td[data-cell]')).toHaveLength(8);
    expect(screen.getByText('Rollup arrived for Monday.')).toBeInTheDocument();
  });

  it('shows Monday to Thursday on Friday, and Friday not yet reported', () => {
    const { status, pending, table } = setup({ playheadMs: simMs(4, 16) });
    expect([0, 1, 2, 3].map(status)).toEqual(['delivered', 'delivered', 'delivered', 'delivered']);
    expect(pending(4)!.textContent).toBe(`${NOT_YET_REPORTED} Arrives Sat 12:00`);
    expect(table.querySelectorAll('td[data-cell]')).toHaveLength(32);
  });

  it('says a due day is computing when the engine has not finished it', () => {
    const wednesday = createFakeIndex({ replicas: 8 })
      .rollup()
      .filter((r) => r.day === 2);
    const { status, pending } = setup({ playheadMs: simMs(3, 13), rows: wednesday });
    expect([0, 1, 2, 3].map(status)).toEqual(['computing', 'computing', 'delivered', 'today']);
    expect(pending(0)!.textContent).toBe(COMPUTING);
  });

  it('switches metric with the picker', async () => {
    const user = userEvent.setup();
    const { table, index } = setup({ playheadMs: simMs(3, 13) });
    const row = index.rollup().find((r) => r.day === 2 && r.replica === 7)!;
    const cell = () => table.querySelector('td[data-cell="2-7"]')!.textContent;
    const picker = screen.getByRole('radiogroup', { name: 'Rollup metric' });
    expect(within(picker).getByRole('radio', { name: 'Served' })).toBeChecked();
    expect(cell()).toBe(formatCount(row.requestsServed));

    await user.click(within(picker).getByRole('radio', { name: 'E2E latency' }));
    expect(table).toHaveAccessibleName('Mean end-to-end latency per replica per day');
    expect(cell()).toBe(`${(row.meanE2eMs / 1000).toFixed(1)} s`);

    await user.keyboard('{ArrowRight}');
    expect(table).toHaveAccessibleName('Mean GPU utilization (nvidia-smi) per replica per day');
    expect(cell()).toBe(formatPercent(row.meanNvidiaSmiUtil));
  });

  it('shows a failed replica only as fewer requests served, with no marker and no error count', () => {
    // Replica 3 was down for part of Wednesday: it served fewer requests, and nothing else says so.
    const base = createFakeIndex({ replicas: 8 }).rollup();
    const rows = base.map((r) =>
      r.day === 2 && r.replica === 2
        ? { ...r, requestsServed: Math.round(r.requestsServed * 0.6) }
        : r,
    );
    const { table } = setup({ playheadMs: simMs(3, 13), rows });
    const dropped = table.querySelector('td[data-cell="2-2"]')!;
    const neighbour = table.querySelector('td[data-cell="2-3"]')!;
    const r3 = rows.find((r) => r.day === 2 && r.replica === 2)!;
    expect(dropped.textContent).toBe(formatCount(r3.requestsServed));
    expect(dropped.className).toBe(neighbour.className);
    expect([...dropped.attributes].map((a) => a.name).sort()).toEqual(
      [...neighbour.attributes].map((a) => a.name).sort(),
    );
    const text = document.body.textContent!;
    expect(text).not.toMatch(/fail|error|down|crash|outage/i);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Served',
      'E2E latency',
      'Utilization',
    ]);
  });

  it('shows a dash for a replica that served nothing', async () => {
    const user = userEvent.setup();
    const rows = createFakeIndex({ replicas: 2 })
      .rollup()
      .map((r) =>
        r.day === 0 && r.replica === 1 ? { ...r, requestsServed: 0, meanE2eMs: NaN } : r,
      );
    const { table } = setup({ replicas: 2, playheadMs: simMs(1, 13), rows });
    expect(table.querySelector('td[data-cell="0-1"]')!.textContent).toBe('0');
    await user.click(screen.getByRole('radio', { name: 'E2E latency' }));
    expect(table.querySelector('td[data-cell="0-1"]')!.textContent).toBe('—');
  });

  it('lays out one replica with single-row pending cells', () => {
    const { table, pending } = setup({ replicas: 1, playheadMs: simMs(2, 14) });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(1);
    expect(pending(2)).toHaveAttribute('rowspan', '1');
    expect(table.querySelectorAll('td[data-cell]')).toHaveLength(2);
  });

  it('re-renders on deliveries and midnights, not while the playhead moves between them', () => {
    const { store, renders, status } = setup({ playheadMs: simMs(2, 12) });
    const start = renders();
    for (let t = simMs(2, 12, 1); t < simMs(2, 24); t += 7 * MINUTE_MS) {
      act(() => store.set({ playheadMs: t }));
    }
    expect(renders()).toBe(start);
    act(() => store.set({ playheadMs: simMs(3, 0) }));
    expect(status(3)).toBe('today');
    expect(renders()).toBe(start + 1);
    act(() => store.set({ playheadMs: simMs(3, 11, 59) }));
    expect(renders()).toBe(start + 1);
    act(() => store.set({ playheadMs: simMs(3, 12) }));
    expect(status(2)).toBe('delivered');
    // The render itself, plus the arrival announcement it sets.
    expect(renders()).toBeGreaterThan(start + 1);
  });
});

describe('formatSeconds', () => {
  it('keeps one decimal so a column lines up, and a dash for no data', () => {
    expect(formatSeconds(6000)).toBe('6.0 s');
    expect(formatSeconds(6149)).toBe('6.1 s');
    expect(formatSeconds(412)).toBe('0.4 s');
    expect(formatSeconds(125_400)).toBe('125 s');
    expect(formatSeconds(NaN)).toBe('—');
  });
});
