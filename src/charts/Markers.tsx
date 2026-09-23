// Point-in-time markers on the charts: the playhead cursor, fork markers, and the lesson moment.
// Neutral ink plus a glyph, never hue alone (K26). Glyphs sit in the plot's top pad (y < 0).

import { chartColors, markers } from './styles.ts';

interface MarkerProps {
  /** x in plot pixels. */
  x: number;
  plotHeight: number;
  /** Text beside the glyph; the top chart only, so labels don't repeat three times. */
  label?: string | null;
}

const LABEL_PROPS = {
  fontSize: 11,
  fill: chartColors.ink,
  stroke: chartColors.surface,
  strokeWidth: 3,
  paintOrder: 'stroke',
  strokeLinejoin: 'round',
} as const;

function MarkerLabel({ x, text, plotWidth }: { x: number; text: string; plotWidth?: number }) {
  // Flip to the left of the line near the right edge.
  const flip = plotWidth !== undefined && x > plotWidth - 120;
  return (
    <text x={flip ? x - 6 : x + 6} y={8} textAnchor={flip ? 'end' : 'start'} {...LABEL_PROPS}>
      {text}
    </text>
  );
}

export function PlayheadMarker({ x, plotHeight }: MarkerProps) {
  const s = markers.playhead;
  return (
    <g data-marker="playhead" transform={`translate(${x},0)`}>
      <line y1={0} y2={plotHeight} stroke={s.color} strokeWidth={s.widthPx} />
      {/* Handle: a small downward-pointing tab above the plot. */}
      <path d="M-4,-8H4V-4L0,0L-4,-4Z" fill={s.color} />
    </g>
  );
}

export function ForkMarker({
  x,
  plotHeight,
  label,
  plotWidth,
}: MarkerProps & { plotWidth?: number }) {
  const s = markers.fork;
  return (
    <g data-marker="fork">
      <line
        x1={x}
        x2={x}
        y1={0}
        y2={plotHeight}
        stroke={s.color}
        strokeWidth={s.widthPx}
        strokeDasharray={s.dash.join(' ')}
      />
      {/* Flag glyph: a pole and a pennant. */}
      <path
        d={`M${x},0V-8L${x + 6},-6L${x},-4`}
        fill={s.color}
        stroke={s.color}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      {label && <MarkerLabel x={x} text={label} plotWidth={plotWidth} />}
    </g>
  );
}

export function LessonMarker({
  x,
  plotHeight,
  label,
  plotWidth,
}: MarkerProps & { plotWidth?: number }) {
  const s = markers.lesson;
  return (
    <g data-marker="lesson">
      <rect
        x={x - s.bandPx / 2}
        y={0}
        width={s.bandPx}
        height={plotHeight}
        fill={s.band}
        fillOpacity={s.bandAlpha}
      />
      {/* Triangle glyph pointing at the moment, inked so it reads without the yellow. */}
      <path
        d={`M${x - 5},-8H${x + 5}L${x},0Z`}
        fill={s.band}
        stroke={s.stroke}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      {label && <MarkerLabel x={x} text={label} plotWidth={plotWidth} />}
    </g>
  );
}

/** The hover or keyboard cursor: a hairline across the plot. */
export function CursorLine({ x, plotHeight }: { x: number; plotHeight: number }) {
  return (
    <line
      data-marker="cursor"
      x1={x}
      x2={x}
      y1={0}
      y2={plotHeight}
      stroke={chartColors.axis}
      strokeWidth={1}
    />
  );
}
