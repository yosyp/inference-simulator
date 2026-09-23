// The stack's shared time axis, under the bottom chart. Live: clock ticks for the window (and the
// cursor's time). High side: day names under each day's band. During the collapse the two cross-fade
// while the domain tweens from the window to the week.

import { scaleLinear } from 'd3-scale';
import { DAY_MS, HOUR_MS, WEEK_DAYS, type SimMs } from '../engine/time.ts';
import { formatClock, formatDay } from './format.ts';
import { PLOT_INSET, STACK_ROWS } from './layout.ts';
import { chartColors } from './styles.ts';

export interface TimeAxisProps {
  width: number;
  plotWidth: number;
  xDomain: readonly [number, number];
  ticks: readonly SimMs[];
  cursorMs?: SimMs | null;
  /** Opacity of the clock ticks and cursor label (collapse staging). */
  clockOpacity?: number;
  /** Opacity of the High-side day labels. */
  dayOpacity?: number;
}

export function TimeAxis({
  width,
  plotWidth,
  xDomain,
  ticks,
  cursorMs = null,
  clockOpacity = 1,
  dayOpacity = 0,
}: TimeAxisProps) {
  const x = scaleLinear().domain(xDomain).range([0, plotWidth]);
  const days = Array.from({ length: WEEK_DAYS }, (_, d) => d);
  const cursorX = cursorMs === null ? null : x(cursorMs);
  const spanMs = xDomain[1] - xDomain[0];
  return (
    <svg width={width} height={STACK_ROWS.axisPx} aria-hidden className="block" data-axis="time">
      <g transform={`translate(${PLOT_INSET.left},0)`} fontSize={11} fill={chartColors.axis}>
        <line x2={plotWidth} stroke={chartColors.axis} strokeWidth={1} />
        {clockOpacity > 0 && (
          <g opacity={clockOpacity}>
            {ticks
              .filter((t) => t >= xDomain[0] && t <= xDomain[1])
              .map((t) => (
                <g key={t} transform={`translate(${x(t)},0)`}>
                  <line y2={3} stroke={chartColors.axis} />
                  <text y={13} textAnchor="middle" className="tabular-nums" data-tick={t}>
                    {formatClock(t)}
                  </text>
                </g>
              ))}
            {cursorX !== null && cursorX >= 0 && cursorX <= plotWidth && (
              <g transform={`translate(${cursorX},0)`} data-cursor-label="">
                <rect x={-30} y={2} width={60} height={14} rx={2} fill={chartColors.ink} />
                <text
                  y={13}
                  textAnchor="middle"
                  fill={chartColors.surface}
                  className="tabular-nums"
                >
                  {formatClock(cursorMs!, spanMs <= 2 * HOUR_MS)}
                </text>
              </g>
            )}
          </g>
        )}
        {dayOpacity > 0 && (
          <g opacity={dayOpacity}>
            {days.map((d) => (
              <text key={d} x={x((d + 0.5) * DAY_MS)} y={13} textAnchor="middle" data-day={d}>
                {formatDay(d * DAY_MS)}
              </text>
            ))}
          </g>
        )}
      </g>
    </svg>
  );
}
