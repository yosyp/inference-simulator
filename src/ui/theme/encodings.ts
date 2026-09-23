// Visual encodings for the canvas (U3), charts (U4), timeline (U5), and legends. Every state pairs a
// color with a second cue (shape, size, fill, dash, hatching, or text) so color is never the only
// signal (05 §7, §10, K18). Sizes are CSS px; multiply by devicePixelRatio on the canvas.

import type { ReplicaState } from '../../engine/results.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import type { DotState } from '../../playback/types.ts';
import { colors } from './colors.ts';

export type DotShape = 'circle' | 'diamond' | 'ring';

export interface DotStyle {
  label: string;
  shape: DotShape;
  /** Circle radius, or the diamond's center-to-vertex distance. */
  radiusPx: number;
  /** null draws no fill (hollow). */
  fill: string | null;
  stroke: string;
  strokeWidthPx: number;
  /** The non-color cue, in words, for legends and tooltips. */
  cue: string;
}

export const dotStyles: Record<DotState, DotStyle> = {
  queued: {
    label: 'Queued',
    shape: 'circle',
    radiusPx: 2.5,
    fill: colors['dot-queued-fill'],
    stroke: colors['dot-queued'],
    strokeWidthPx: 1.25,
    cue: 'Small outlined dot',
  },
  prefill: {
    label: 'Prefill',
    shape: 'diamond',
    radiusPx: 4.5,
    fill: colors['dot-prefill'],
    stroke: colors['dot-prefill-stroke'],
    strokeWidthPx: 1,
    cue: 'Filled diamond',
  },
  decode: {
    label: 'Decode',
    shape: 'circle',
    radiusPx: 4,
    fill: colors['dot-decode'],
    stroke: colors['dot-decode-stroke'],
    strokeWidthPx: 1,
    cue: 'Filled dot',
  },
  preempted: {
    label: 'Preempted',
    shape: 'ring',
    radiusPx: 4.5,
    fill: null,
    stroke: colors['dot-preempted'],
    strokeWidthPx: 2,
    cue: 'Hollow ring',
  },
};

/** Drawn around the tracked analyst's dots, with a TTFT label beside them. */
export const trackedStyle = {
  haloStroke: colors['dot-tracked'],
  haloWidthPx: 1.5,
  /** Gap between the dot's edge and the halo. */
  haloGapPx: 2,
  labelColor: colors.ink,
  /** Stroke text in this color first so labels stay legible over dots. */
  labelHalo: colors['canvas-bg'],
} as const;

export type ReplicaStyleKey =
  'ready' | 'crashed' | 'down' | 'loadingWeights' | 'initializingEngine';

export interface ReplicaStyle {
  label: string;
  fill: string;
  stroke: string;
  strokeWidthPx: number;
  /** Canvas setLineDash pattern; empty for solid. */
  dash: readonly number[];
  /** Diagonal hatching over the fill; null for none. */
  hatch: { color: string; spacingPx: number; widthPx: number } | null;
  /** Show a progress bar through the loading phase (ReplicaSnapshot.phaseProgress). */
  progress: { fill: string; track: string } | null;
  /** Label and text color drawn on the replica. */
  ink: string;
  /** Whether the KV tank and dots are drawn. A rejoining replica shows an empty tank (05 §7). */
  showsTank: boolean;
  cue: string;
}

const downHatch = { color: colors['replica-down-hatch'], spacingPx: 6, widthPx: 1 } as const;
const loadingProgress = { fill: colors['replica-loading'], track: colors['kv-track'] } as const;

export const replicaStyles: Record<ReplicaStyleKey, ReplicaStyle> = {
  ready: {
    label: 'Ready',
    fill: colors['replica-ready'],
    stroke: colors['replica-ready-stroke'],
    strokeWidthPx: 1,
    dash: [],
    hatch: null,
    progress: null,
    ink: colors.ink,
    showsTank: true,
    cue: 'Solid outline, light fill',
  },
  crashed: {
    label: 'Crashed',
    fill: colors['replica-down'],
    stroke: colors['replica-crashed-stroke'],
    strokeWidthPx: 2,
    dash: [],
    hatch: downHatch,
    progress: null,
    ink: colors['replica-down-ink'],
    showsTank: false,
    cue: 'Dark hatched fill, heavy border: dead, but the router still sends to it',
  },
  down: {
    label: 'Down',
    fill: colors['replica-down'],
    stroke: colors['replica-down-stroke'],
    strokeWidthPx: 1,
    dash: [],
    hatch: downHatch,
    progress: null,
    ink: colors['replica-down-ink'],
    showsTank: false,
    cue: 'Dark hatched fill: marked down',
  },
  loadingWeights: {
    label: 'Loading weights',
    fill: colors['replica-loading-fill'],
    stroke: colors['replica-loading-stroke'],
    strokeWidthPx: 1.5,
    dash: [5, 3],
    hatch: null,
    progress: loadingProgress,
    ink: colors.ink,
    showsTank: true,
    cue: 'Dashed outline with a progress bar',
  },
  initializingEngine: {
    label: 'Starting engine',
    fill: colors['replica-loading-fill'],
    stroke: colors['replica-loading-stroke'],
    strokeWidthPx: 1.5,
    dash: [5, 3],
    hatch: null,
    progress: loadingProgress,
    ink: colors.ink,
    showsTank: true,
    cue: 'Dashed outline with a progress bar',
  },
};

const replicaKeyByState: Record<ReplicaState, ReplicaStyleKey> = {
  [REPLICA_STATE.ready]: 'ready',
  [REPLICA_STATE.crashed]: 'crashed',
  [REPLICA_STATE.down]: 'down',
  [REPLICA_STATE.loadingWeights]: 'loadingWeights',
  [REPLICA_STATE.initializingEngine]: 'initializingEngine',
};

/** Maps the engine's numeric ReplicaState to its style key. */
export function replicaStyleKey(state: ReplicaState): ReplicaStyleKey {
  return replicaKeyByState[state];
}

export function replicaStyle(state: ReplicaState): ReplicaStyle {
  return replicaStyles[replicaKeyByState[state]];
}

export const kvTankStyle = {
  fill: colors.kv,
  track: colors['kv-track'],
  stroke: colors['kv-stroke'],
  strokeWidthPx: 1,
} as const;

export interface SeriesStyle {
  color: string;
  widthPx: number;
  /** SVG stroke-dasharray / canvas setLineDash; empty for solid. */
  dash: readonly number[];
}

/**
 * Chart line styles. Suggested use per chart is in README.md. Lines that share a chart differ in
 * dash or width as well as hue.
 */
export const seriesStyles = {
  mean: { color: colors['series-mean'], widthPx: 1.5, dash: [] },
  p99: { color: colors['series-p99'], widthPx: 2, dash: [] },
  secondary: { color: colors['series-secondary'], widthPx: 1.25, dash: [4, 3] },
  worst: { color: colors['series-worst'], widthPx: 1.5, dash: [] },
  muted: { color: colors['series-muted'], widthPx: 1, dash: [] },
  kv: { color: colors['series-kv'], widthPx: 1.5, dash: [] },
} as const satisfies Record<string, SeriesStyle>;

export type SeriesRole = keyof typeof seriesStyles;

/** Point-in-time annotations on charts and the timeline. Neutral ink plus a glyph, never hue alone. */
export const markerStyles = {
  fork: {
    color: colors['series-fork'],
    widthPx: 1,
    dash: [3, 3],
    glyph: 'flag',
    label: 'Fork',
  },
  incident: {
    /** A translucent band around the moment; draw with withAlpha(color, bandAlpha). */
    color: colors['series-incident'],
    bandAlpha: 0.5,
    glyphStroke: colors['series-incident-stroke'],
    glyph: 'triangle',
    label: 'Incident',
  },
  preemption: {
    color: colors['series-preemption'],
    glyph: 'tick',
    label: 'Preemption',
  },
  playhead: {
    color: colors['series-playhead'],
    widthPx: 1.5,
    dash: [],
    glyph: 'handle',
    label: 'Playhead',
  },
} as const;
