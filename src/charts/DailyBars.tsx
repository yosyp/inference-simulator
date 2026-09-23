// High-side daily bars (05 §9): one bar per replica per day from RollupRow-shaped data, grouped
// under each day's band on the same week axis the collapse animates to. Days whose rollup has not
// arrived yet are dashed outlines. U7 decides which rows and pending days to pass.

import { scaleLinear } from 'd3-scale';
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { RollupRow } from '../engine/results.ts';
import { DAY_MS, WEEK_MS, rollupDeliveryMs, type DayIndex } from '../engine/time.ts';
import { ChartHeader } from './ChartHeader.tsx';
import {
  formatClock,
  formatCount,
  formatDay,
  formatMs,
  formatPercent,
  msTickFormat,
  percentTickFormat,
  plainTickFormat,
} from './format.ts';
import { PLOT_INSET, PLOT_PAD, STACK_ROWS } from './layout.ts';
import type { AxisTick } from './panel-types.ts';
import { barPath } from './paths.ts';
import type { LegendEntry } from './readout.ts';
import { unitAxis, zeroBasedAxis } from './series.ts';
import { chartColors, replicaLabel } from './styles.ts';

export type RollupMetric = 'meanE2eMs' | 'meanNvidiaSmiUtil' | 'requestsServed';

const METRICS: Record<RollupMetric, { label: string; format: (v: number) => string }> = {
  meanE2eMs: { label: 'Mean E2E latency', format: formatMs },
  meanNvidiaSmiUtil: { label: 'Mean utilization (nvidia-smi)', format: formatPercent },
  requestsServed: { label: 'Requests served', format: formatCount },
};

/** Widest bar, and the gap between neighbours in a day's group. */
export const BAR_MAX_PX = 24;
export const BAR_GAP_PX = 2;

export interface DailyBarsProps {
  rows: readonly RollupRow[];
  metric: RollupMetric;
  replicas: number;
  width: number;
  /** Total height, title row included. */
  height: number;
  title?: string;
  /** Days still waiting for their rollup (the current day, and yesterday before 12:00). */
  pendingDays?: readonly DayIndex[];
  /** 0..1 bar growth, for the Live-to-High-side collapse. */
  progress?: number;
}

interface Bar {
  row: RollupRow;
  x: number;
  width: number;
  value: number;
}

function axisFor(
  metric: RollupMetric,
  max: number,
): { domain: [number, number]; ticks: AxisTick[] } {
  if (metric === 'meanNvidiaSmiUtil') return unitAxis(percentTickFormat());
  if (metric === 'meanE2eMs') return zeroBasedAxis(max, 100, msTickFormat);
  return zeroBasedAxis(max, 10, () => plainTickFormat());
}

/** Bar geometry in plot pixels: replicas side by side, centred in each day's band. */
export function layoutBars(
  rows: readonly RollupRow[],
  metric: RollupMetric,
  replicas: number,
  plotWidth: number,
): Bar[] {
  const x = scaleLinear().domain([0, WEEK_MS]).range([0, plotWidth]);
  const band = x(DAY_MS) - x(0);
  const n = Math.max(1, replicas);
  const group = Math.min(band * 0.8, n * BAR_MAX_PX + (n - 1) * BAR_GAP_PX);
  const barW = Math.max(1, (group - (n - 1) * BAR_GAP_PX) / n);
  return [...rows]
    .filter((r) => Number.isFinite(r[metric]))
    .sort((a, b) => a.day - b.day || a.replica - b.replica)
    .map((row) => ({
      row,
      x: x((row.day + 0.5) * DAY_MS) - group / 2 + row.replica * (barW + BAR_GAP_PX),
      width: barW,
      value: row[metric],
    }));
}

export function DailyBars({
  rows,
  metric,
  replicas,
  width,
  height,
  title = METRICS[metric].label,
  pendingDays = [],
  progress = 1,
}: DailyBarsProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const plotWidth = Math.max(1, width - PLOT_INSET.left - PLOT_INSET.right);
  const svgHeight = height - STACK_ROWS.headerPx;
  const plotHeight = Math.max(1, svgHeight - PLOT_PAD.top - PLOT_PAD.bottom);
  const bars = layoutBars(rows, metric, replicas, plotWidth);
  const axis = axisFor(metric, Math.max(0, ...bars.map((b) => b.value)));
  const y = scaleLinear().domain(axis.domain).range([plotHeight, 0]).clamp(true);
  const x = scaleLinear().domain([0, WEEK_MS]).range([0, plotWidth]);
  const band = x(DAY_MS) - x(0);
  const { format, label } = METRICS[metric];
  const sel = selected !== null && selected < bars.length ? bars[selected]! : null;

  const describe = (b: Bar) =>
    `${formatDay(b.row.day * DAY_MS)} ${replicaLabel(b.row.replica)}: ${format(b.value)}` +
    `, ${formatCount(b.row.requestsServed)} served`;
  const entries: LegendEntry[] = sel
    ? [
        {
          id: 'value',
          label: `${formatDay(sel.row.day * DAY_MS)} ${replicaLabel(sel.row.replica)}`,
          value: format(sel.value),
          swatch: { kind: 'bar', color: chartColors.highSideBar },
        },
        {
          id: 'served',
          label: 'served',
          value: formatCount(sel.row.requestsServed),
          swatch: { kind: 'none' },
        },
      ]
    : [
        {
          id: 'value',
          label: `${label[0]!.toLowerCase()}${label.slice(1)} per replica per day`,
          value: '',
          swatch: { kind: 'bar', color: chartColors.highSideBar },
        },
      ];

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left - PLOT_INSET.left;
    const i = bars.findIndex(
      (b) => px >= b.x - BAR_GAP_PX / 2 && px < b.x + b.width + BAR_GAP_PX / 2,
    );
    setSelected(i >= 0 ? i : null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (bars.length === 0) return;
    const last = bars.length - 1;
    const cur = selected ?? -1;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(last, cur + 1);
    else if (e.key === 'ArrowLeft') next = cur < 0 ? last : Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape') next = null;
    if (next === undefined) return;
    e.preventDefault();
    setSelected(next);
  };

  return (
    <div
      role="group"
      aria-label={`${title}, daily rollup`}
      data-chart="dailyBars"
      data-metric={metric}
    >
      <ChartHeader title={title} entries={entries} note="Each day arrives the next day at 12:00" />
      <div
        tabIndex={0}
        role="group"
        aria-label={`${title}: ${bars.length} daily bars. Arrow keys read each bar.`}
        onKeyDown={onKeyDown}
        className="outline-offset-[-2px]"
      >
        <svg
          width={width}
          height={svgHeight}
          aria-hidden
          className="block"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setSelected(null)}
        >
          <g transform={`translate(${PLOT_INSET.left},${PLOT_PAD.top})`}>
            {axis.ticks.map((tk) => (
              <g key={tk.value} transform={`translate(0,${y(tk.value)})`}>
                <line x2={plotWidth} stroke={chartColors.grid} strokeWidth={1} />
                <text
                  x={-6}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill={chartColors.axis}
                  className="tabular-nums"
                >
                  {tk.label}
                </text>
              </g>
            ))}
            {pendingDays.map((d) => {
              const bx = x(d * DAY_MS) + band * 0.1;
              return (
                <g key={`pending-${d}`} data-pending-day={d}>
                  <rect
                    x={bx}
                    y={0}
                    width={band * 0.8}
                    height={plotHeight}
                    rx={3}
                    fill="none"
                    stroke={chartColors.highSidePending}
                    strokeDasharray="4 3"
                  />
                  {band * 0.8 >= 90 && (
                    <text
                      x={bx + band * 0.4}
                      y={plotHeight / 2}
                      dy="0.32em"
                      textAnchor="middle"
                      fontSize={11}
                      fill={chartColors.axis}
                    >
                      {`Arrives ${formatDay(rollupDeliveryMs(d))} ${formatClock(rollupDeliveryMs(d))}`}
                    </text>
                  )}
                </g>
              );
            })}
            {bars.map((b, i) => (
              <path
                key={`${b.row.day}-${b.row.replica}`}
                data-bar={`${b.row.day}-${b.row.replica}`}
                d={barPath(b.x, b.width, plotHeight, y(b.value * progress))}
                fill={chartColors.highSideBar}
                stroke={i === selected ? chartColors.ink : 'none'}
                strokeWidth={1.5}
              />
            ))}
          </g>
        </svg>
      </div>
      <p className="sr-only" aria-live="polite">
        {sel ? describe(sel) : ''}
      </p>
    </div>
  );
}
