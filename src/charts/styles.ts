// Chart encodings: the theme's seriesStyles and markerStyles with CSS-variable colors for SVG
// (src/ui/theme/README.md, "Charts and markers"). Lines that share a chart differ in dash or width
// as well as hue, and markers are neutral ink plus a glyph (K26).

import { cssVar, markerStyles, seriesStyles, type SeriesStyle } from '../ui/theme/index.ts';

export const chartColors = {
  axis: cssVar('chart-axis'),
  grid: cssVar('chart-grid'),
  ink: cssVar('ink'),
  inkMuted: cssVar('ink-muted'),
  surface: cssVar('surface'),
  incidentBand: cssVar('series-incident'),
  incidentStroke: cssVar('series-incident-stroke'),
  fork: cssVar('series-fork'),
  playhead: cssVar('series-playhead'),
  preemption: cssVar('series-preemption'),
  highSideBar: cssVar('high-side-bar'),
  highSidePending: cssVar('high-side-bar-pending'),
} as const;

export const lineStyles = {
  mean: { ...seriesStyles.mean, color: cssVar('series-mean') },
  p99: { ...seriesStyles.p99, color: cssVar('series-p99') },
  secondary: { ...seriesStyles.secondary, color: cssVar('series-secondary') },
  worst: { ...seriesStyles.worst, color: cssVar('series-worst') },
  muted: { ...seriesStyles.muted, color: cssVar('series-muted') },
  kv: { ...seriesStyles.kv, color: cssVar('series-kv') },
  /** Chart 3 rejects: vermillion like other failure signals, dotted to set it apart from p99. */
  rejected: { color: cssVar('series-p99'), widthPx: 1.25, dash: [1.5, 2.5] },
} as const satisfies Record<string, SeriesStyle>;

export const markers = {
  fork: { ...markerStyles.fork, color: chartColors.fork },
  lesson: {
    ...markerStyles.incident,
    band: chartColors.incidentBand,
    stroke: chartColors.incidentStroke,
    /** Band width in px, centered on the moment, so it reads at every zoom. */
    bandPx: 8,
  },
  playhead: { ...markerStyles.playhead, color: chartColors.playhead },
  preemption: { ...markerStyles.preemption, color: chartColors.preemption },
} as const;

/** SVG stroke-dasharray for a style, or undefined for solid. */
export function dashArray(style: SeriesStyle): string | undefined {
  return style.dash.length > 0 ? style.dash.join(' ') : undefined;
}

/** "R3": replicas are numbered from 1 on screen, as on the canvas and in the status line. */
export function replicaLabel(replica: number): string {
  return `R${replica + 1}`;
}
