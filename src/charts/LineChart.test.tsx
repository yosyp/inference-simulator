// Marker placement and rendering of one live chart.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { simMs } from '../engine/time.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import { buildLatencyPanel } from './latency-panel.ts';
import { PLOT_INSET, stackGeometry } from './layout.ts';
import { LineChart } from './LineChart.tsx';
import { buildMemoryPanel } from './memory-panel.ts';
import type { PanelInput } from './panel-types.ts';
import { pathVertexCount } from './paths.ts';
import { scaleCounts } from './test-support.ts';

const WINDOW = { fromMs: simMs(2, 7), toMs: simMs(2, 17) };
const geo = stackGeometry(PLOT_INSET.left + 1000 + PLOT_INSET.right);
const input: PanelInput = {
  index: scaleCounts(createFakeIndex({ replicas: 4 }), 100),
  window: WINDOW,
  columns: geo.columns,
  visibleToMs: simMs(2, 12),
};
/** 1000 px for 10 h: 36 s per pixel. */
const xOf = (ms: number) => ((ms - WINDOW.fromMs) / (WINDOW.toMs - WINDOW.fromMs)) * 1000;

function markerX(el: Element): number {
  const tr = el.getAttribute('transform');
  if (tr) return Number(/translate\(([-\d.]+)/.exec(tr)![1]);
  const line = el.tagName === 'line' ? el : el.querySelector('line')!;
  return Number(line.getAttribute('x1'));
}

describe('LineChart markers', () => {
  it('places the playhead, forks, the lesson moment, and the cursor on the time scale', () => {
    const panel = buildLatencyPanel(input);
    const { container } = render(
      <LineChart
        panel={panel}
        geometry={geo}
        xDomain={[WINDOW.fromMs, WINDOW.toMs]}
        playheadMs={simMs(2, 12)}
        forks={[
          { atMs: simMs(2, 9, 30), revision: 1, label: 'Routing: least outstanding' },
          { atMs: simMs(1, 9), revision: 2, label: 'Off-window' },
        ]}
        lessonMoment={{ atMs: simMs(2, 10, 30), label: 'Long prompt' }}
        cursorMs={simMs(2, 11)}
        markerLabels
      />,
    );
    const playhead = container.querySelector('[data-marker="playhead"]')!;
    expect(markerX(playhead)).toBeCloseTo(xOf(simMs(2, 12)), 6);
    const forks = container.querySelectorAll('[data-marker="fork"]');
    expect(forks).toHaveLength(1);
    expect(markerX(forks[0]!)).toBeCloseTo(xOf(simMs(2, 9, 30)), 6);
    const lesson = container.querySelector('[data-marker="lesson"] rect')!;
    const band = Number(lesson.getAttribute('x')) + Number(lesson.getAttribute('width')) / 2;
    expect(band).toBeCloseTo(xOf(simMs(2, 10, 30)), 6);
    expect(markerX(container.querySelector('[data-marker="cursor"]')!)).toBeCloseTo(
      xOf(simMs(2, 11)),
      6,
    );
    // Labels on the top chart: text in neutral ink beside glyphs, not hue alone (K26).
    expect(screen.getByText('Routing: least outstanding')).toBeInTheDocument();
    expect(screen.getByText('Long prompt')).toBeInTheDocument();
  });

  it('hides markers outside the window and labels on lower charts', () => {
    const panel = buildMemoryPanel(input);
    const { container } = render(
      <LineChart
        panel={panel}
        geometry={geo}
        xDomain={[WINDOW.fromMs, WINDOW.toMs]}
        playheadMs={simMs(3, 8)}
        forks={[{ atMs: simMs(2, 9), revision: 1, label: 'Fork label' }]}
        lessonMoment={{ atMs: simMs(2, 10), label: 'Lesson label' }}
      />,
    );
    expect(container.querySelector('[data-marker="playhead"]')).toBeNull();
    expect(container.querySelector('[data-marker="fork"]')).not.toBeNull();
    expect(screen.queryByText('Fork label')).toBeNull();
    expect(screen.queryByText('Lesson label')).toBeNull();
  });

  it('draws each line with no more vertices than columns, and a legend that reads values', () => {
    const panel = buildLatencyPanel(input);
    const { container } = render(
      <LineChart
        panel={panel}
        geometry={geo}
        xDomain={[WINDOW.fromMs, WINDOW.toMs]}
        playheadMs={simMs(2, 12)}
      />,
    );
    const paths = container.querySelectorAll('path[data-series]');
    expect(paths.length).toBe(panel.lines.length);
    for (const p of paths) {
      expect(pathVertexCount(p.getAttribute('d')!)).toBeLessThanOrEqual(geo.columns);
    }
    expect(container.querySelector('[data-legend="ttftP99"]')!.textContent).toMatch(
      /\d+ (ms|s)TTFT p99/,
    );
    expect(container.querySelector('[data-end-label="worstP99"]')!.textContent).toMatch(
      /^R\d, worst$/,
    );
  });

  it('reports the pointer time for the shared cursor', () => {
    const onCursor = vi.fn();
    const { container } = render(
      <LineChart
        panel={buildMemoryPanel(input)}
        geometry={geo}
        xDomain={[WINDOW.fromMs, WINDOW.toMs]}
        playheadMs={simMs(2, 12)}
        onCursor={onCursor}
      />,
    );
    const svg = container.querySelector('svg:not([width="16"])')!;
    fireEvent.pointerMove(svg, { clientX: PLOT_INSET.left + 500 });
    expect(onCursor).toHaveBeenLastCalledWith(simMs(2, 12));
    fireEvent.pointerLeave(svg);
    expect(onCursor).toHaveBeenLastCalledWith(null);
  });
});
