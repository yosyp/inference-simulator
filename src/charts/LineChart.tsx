// One live chart: React-rendered SVG from a ChartPanel, with d3 scales and path math only (K13).
// Draws gridlines, y ticks, lines, request points, preemption ticks, the lesson moment, forks, the
// playhead, and the hover cursor, under a title row whose legend is the readout.

import { interpolateNumberArray } from 'd3-interpolate';
import { scaleLinear, scaleLog } from 'd3-scale';
import { useId, useMemo, type PointerEvent, type ReactNode } from 'react';
import type { SimMs } from '../engine/time.ts';
import type { ForkMarker as Fork } from '../playback/types.ts';
import { ChartHeader } from './ChartHeader.tsx';
import { PLOT_INSET, PLOT_PAD, type StackGeometry } from './layout.ts';
import { CursorLine, ForkMarker, LessonMarker, PlayheadMarker } from './Markers.tsx';
import type { ChartPanel } from './panel-types.ts';
import { linePath } from './paths.ts';
import { legendEntries } from './readout.ts';
import { finiteMax, finiteMean } from './series.ts';
import { chartColors, dashArray } from './styles.ts';

export interface LessonMoment {
  atMs: SimMs;
  label: string;
}

export interface LineChartProps {
  panel: ChartPanel;
  geometry: Pick<StackGeometry, 'width' | 'plotWidth' | 'svgHeight' | 'plotHeight'>;
  /** The shared time window (tweened toward the week during the High-side collapse). */
  xDomain: readonly [number, number];
  /** Markers show only inside this range. Default xDomain; the live window during the collapse. */
  markerRange?: readonly [number, number];
  playheadMs: SimMs | null;
  forks?: readonly Fork[];
  lessonMoment?: LessonMoment | null;
  /** Shared hover or keyboard cursor. */
  cursorMs?: SimMs | null;
  /** Show fork and lesson labels (the top chart). */
  markerLabels?: boolean;
  /** Vertical gridlines, aligned with the time axis. */
  gridTimes?: readonly SimMs[];
  /** 0 = live; toward 1 the values flatten to their mean (K13). */
  morph?: number;
  /** Opacity of the title row, ticks, gridlines, and markers (collapse staging). */
  chromeOpacity?: number;
  /** Opacity of the lines, points, and preemption ticks. */
  dataOpacity?: number;
  onCursor?: (ms: SimMs | null) => void;
  /** Extra header content (the zoom controls on the top chart). */
  headerExtra?: ReactNode;
}

/** Values moved toward their mean by p, with gaps kept: the Live-to-High-side collapse. */
export function flattenToward(v: Float64Array, p: number): Float64Array {
  if (p <= 0 || v.length === 0) return v;
  const target = new Float64Array(v.length).fill(finiteMean(v));
  return Float64Array.from(interpolateNumberArray(v, target)(Math.min(1, p)));
}

function inside(ms: number, domain: readonly [number, number]): boolean {
  return ms >= domain[0] && ms <= domain[1];
}

export function LineChart({
  panel,
  geometry,
  xDomain,
  markerRange = xDomain,
  playheadMs,
  forks = [],
  lessonMoment = null,
  cursorMs = null,
  markerLabels = false,
  gridTimes = [],
  morph = 0,
  chromeOpacity = 1,
  dataOpacity = 1,
  onCursor,
  headerExtra,
}: LineChartProps) {
  const clipId = `chart-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { width, plotWidth, svgHeight, plotHeight } = geometry;
  const x = scaleLinear().domain(xDomain).range([0, plotWidth]);
  const y =
    panel.yScale === 'log'
      ? scaleLog().domain(panel.yDomain).range([plotHeight, 0]).clamp(true)
      : scaleLinear().domain(panel.yDomain).range([plotHeight, 0]).clamp(true);
  const pixelMs = (xDomain[1] - xDomain[0]) / Math.max(1, plotWidth);
  // Path strings only change with the data, the x domain, the plot size, or the collapse morph.
  // The playhead and cursor re-render the chart ~10×/s, so rebuilding them there was the stack's
  // main cost at low speeds (P5).
  const [x0, x1] = xDomain;
  const paths = useMemo(
    () =>
      panel.lines.map((l) =>
        l.hidden ? '' : linePath(l.t, flattenToward(l.v, morph), l.stepMs, x, y),
      ),
    // x and y are rebuilt every render from exactly these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panel, morph, x0, x1, plotWidth, plotHeight],
  );
  const entries = legendEntries(panel, morph > 0 ? null : cursorMs, pixelMs);
  const marked = (ms: number) => inside(ms, markerRange) && inside(ms, xDomain);

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!onCursor) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left - PLOT_INSET.left;
    onCursor(px >= 0 && px <= plotWidth ? x.invert(px) : null);
  };

  const ticks = panel.ticks;
  const tickMax = ticks ? finiteMax(ticks.v) : NaN;

  return (
    <div role="group" aria-label={panel.title} data-chart={panel.kind} data-mode={panel.mode}>
      <div style={chromeOpacity < 1 ? { opacity: chromeOpacity } : undefined}>
        <ChartHeader title={panel.title} entries={entries} note={panel.note}>
          {headerExtra}
        </ChartHeader>
      </div>
      <svg
        width={width}
        height={svgHeight}
        aria-hidden
        className="block overflow-visible"
        onPointerMove={onPointerMove}
        onPointerLeave={() => onCursor?.(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <g transform={`translate(${PLOT_INSET.left},${PLOT_PAD.top})`}>
          <g opacity={chromeOpacity}>
            {panel.yTicks.map((tk) => (
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
          </g>
          <g opacity={chromeOpacity}>
            {gridTimes
              .filter((t) => inside(t, xDomain))
              .map((t) => (
                <line
                  key={t}
                  x1={x(t)}
                  x2={x(t)}
                  y2={plotHeight}
                  stroke={chartColors.grid}
                  strokeWidth={1}
                />
              ))}
            {lessonMoment && marked(lessonMoment.atMs) && (
              <LessonMarker
                x={x(lessonMoment.atMs)}
                plotHeight={plotHeight}
                plotWidth={plotWidth}
                label={markerLabels ? lessonMoment.label : null}
              />
            )}
          </g>
          <g clipPath={`url(#${clipId})`} opacity={dataOpacity}>
            {panel.lines.map((l, i) =>
              l.hidden ? null : (
                <path
                  key={l.id}
                  data-series={l.id}
                  d={paths[i]}
                  fill="none"
                  stroke={l.style.color}
                  strokeWidth={l.style.widthPx}
                  strokeDasharray={dashArray(l.style)}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ),
            )}
            {panel.points.map((pts) => {
              const v = flattenToward(pts.v, morph);
              return (
                <g key={pts.id} data-series={pts.id}>
                  {Array.from(pts.t, (t, i) =>
                    Number.isFinite(v[i]!) ? (
                      <circle
                        key={i}
                        cx={x(t)}
                        cy={y(v[i]!)}
                        r={3}
                        fill={pts.shape === 'dot' ? pts.color : 'none'}
                        stroke={pts.shape === 'dot' ? chartColors.surface : pts.color}
                        strokeWidth={pts.shape === 'dot' ? 1 : 1.5}
                      />
                    ) : null,
                  )}
                </g>
              );
            })}
            {ticks && (
              <g data-series={ticks.id}>
                {Array.from(ticks.t, (t, i) => {
                  const n = ticks.v[i]!;
                  if (!(n > 0)) return null;
                  const len = 3 + 7 * Math.sqrt(n / tickMax);
                  const px = x(t + ticks.stepMs / 2);
                  return (
                    <line
                      key={i}
                      x1={px}
                      x2={px}
                      y1={0}
                      y2={len}
                      stroke={ticks.color}
                      strokeWidth={1.5}
                    />
                  );
                })}
              </g>
            )}
          </g>
          <g opacity={chromeOpacity}>
            {panel.lines
              .filter((l) => l.endLabel && !l.hidden)
              .map((l) => {
                const i = lastIndex(l.v);
                if (i < 0) return null;
                const px = x(l.t[i]! + l.stepMs / 2);
                const py = y(flattenToward(l.v, morph)[i]!);
                const flip = px > plotWidth - 64;
                return (
                  <text
                    key={`${l.id}-label`}
                    data-end-label={l.id}
                    x={flip ? px - 4 : px + 4}
                    y={py - 4}
                    textAnchor={flip ? 'end' : 'start'}
                    fontSize={11}
                    fill={chartColors.ink}
                    stroke={chartColors.surface}
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {l.endLabel}
                  </text>
                );
              })}
            {forks
              .filter((f) => marked(f.atMs))
              .map((f) => (
                <ForkMarker
                  key={`${f.revision}-${f.atMs}`}
                  x={x(f.atMs)}
                  plotHeight={plotHeight}
                  plotWidth={plotWidth}
                  label={markerLabels ? f.label || 'Fork' : null}
                />
              ))}
            {playheadMs !== null && marked(playheadMs) && (
              <PlayheadMarker x={x(playheadMs)} plotHeight={plotHeight} />
            )}
            {cursorMs !== null && marked(cursorMs) && (
              <CursorLine x={x(cursorMs)} plotHeight={plotHeight} />
            )}
          </g>
        </g>
      </svg>
    </div>
  );
}

function lastIndex(v: ArrayLike<number>): number {
  for (let i = v.length - 1; i >= 0; i--) if (Number.isFinite(v[i]!)) return i;
  return -1;
}
