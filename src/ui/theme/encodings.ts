// Visual encodings for the canvas (U3), charts (U4), timeline (U5), and legends. Every state pairs a
// color with a second cue (shape, size, fill, dash, hatching, or text) so color is never the only
// signal (05 §7, §10, K18). Sizes are CSS px; multiply by devicePixelRatio on the canvas.

import type { ReplicaState } from '../../engine/results.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import type { DotState } from '../../playback/types.ts';
import { colors, type Palette } from './colors.ts';

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

export interface SeriesStyle {
  color: string;
  widthPx: number;
  /** SVG stroke-dasharray / canvas setLineDash; empty for solid. */
  dash: readonly number[];
}

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

/** Every encoding, with its colors taken from one palette. */
export function encodingsFor(c: Palette) {
  const dotStyles: Record<DotState, DotStyle> = {
    queued: {
      label: 'Queued',
      shape: 'circle',
      radiusPx: 2.5,
      fill: c['dot-queued-fill'],
      stroke: c['dot-queued'],
      strokeWidthPx: 1.25,
      cue: 'Small outlined dot',
    },
    prefill: {
      label: 'Prefill',
      shape: 'diamond',
      radiusPx: 4.5,
      fill: c['dot-prefill'],
      stroke: c['dot-prefill-stroke'],
      strokeWidthPx: 1,
      cue: 'Filled diamond',
    },
    decode: {
      label: 'Decode',
      shape: 'circle',
      radiusPx: 4,
      fill: c['dot-decode'],
      stroke: c['dot-decode-stroke'],
      strokeWidthPx: 1,
      cue: 'Filled dot',
    },
    preempted: {
      label: 'Preempted',
      shape: 'ring',
      radiusPx: 4.5,
      fill: null,
      stroke: c['dot-preempted'],
      strokeWidthPx: 2,
      cue: 'Hollow ring',
    },
  };

  /** Drawn around the tracked analyst's dots, with a TTFT label beside them. */
  const trackedStyle = {
    haloStroke: c['dot-tracked'],
    haloWidthPx: 1.5,
    /** Gap between the dot's edge and the halo. */
    haloGapPx: 2,
    labelColor: c.ink,
    /** Stroke text in this color first so labels stay legible over dots. */
    labelHalo: c['canvas-bg'],
  } as const;

  const downHatch = { color: c['replica-down-hatch'], spacingPx: 6, widthPx: 1 } as const;
  const loadingProgress = { fill: c['replica-loading'], track: c['kv-track'] } as const;

  const replicaStyles: Record<ReplicaStyleKey, ReplicaStyle> = {
    ready: {
      label: 'Ready',
      fill: c['replica-ready'],
      stroke: c['replica-ready-stroke'],
      strokeWidthPx: 1,
      dash: [],
      hatch: null,
      progress: null,
      ink: c.ink,
      showsTank: true,
      cue: 'Solid outline, light fill',
    },
    crashed: {
      label: 'Crashed',
      fill: c['replica-down'],
      stroke: c['replica-crashed-stroke'],
      strokeWidthPx: 2,
      dash: [],
      hatch: downHatch,
      progress: null,
      ink: c['replica-down-ink'],
      showsTank: false,
      cue: 'Dark hatched fill, heavy border: dead, but the router still sends to it',
    },
    down: {
      label: 'Down',
      fill: c['replica-down'],
      stroke: c['replica-down-stroke'],
      strokeWidthPx: 1,
      dash: [],
      hatch: downHatch,
      progress: null,
      ink: c['replica-down-ink'],
      showsTank: false,
      cue: 'Dark hatched fill: marked down',
    },
    loadingWeights: {
      label: 'Loading weights',
      fill: c['replica-loading-fill'],
      stroke: c['replica-loading-stroke'],
      strokeWidthPx: 1.5,
      dash: [5, 3],
      hatch: null,
      progress: loadingProgress,
      ink: c.ink,
      showsTank: true,
      cue: 'Dashed outline with a progress bar',
    },
    initializingEngine: {
      label: 'Starting engine',
      fill: c['replica-loading-fill'],
      stroke: c['replica-loading-stroke'],
      strokeWidthPx: 1.5,
      dash: [5, 3],
      hatch: null,
      progress: loadingProgress,
      ink: c.ink,
      showsTank: true,
      cue: 'Dashed outline with a progress bar',
    },
  };

  const kvTankStyle = {
    fill: c.kv,
    track: c['kv-track'],
    stroke: c['kv-stroke'],
    strokeWidthPx: 1,
  } as const;

  /**
   * Chart line styles. Suggested use per chart is in README.md. Lines that share a chart differ in
   * dash or width as well as hue.
   */
  const seriesStyles = {
    mean: { color: c['series-mean'], widthPx: 1.5, dash: [] },
    p99: { color: c['series-p99'], widthPx: 2, dash: [] },
    secondary: { color: c['series-secondary'], widthPx: 1.25, dash: [4, 3] },
    worst: { color: c['series-worst'], widthPx: 1.5, dash: [] },
    muted: { color: c['series-muted'], widthPx: 1, dash: [] },
    kv: { color: c['series-kv'], widthPx: 1.5, dash: [] },
  } as const satisfies Record<string, SeriesStyle>;

  /** Point-in-time annotations on charts and the timeline. Neutral ink plus a glyph, never hue alone. */
  const markerStyles = {
    fork: {
      color: c['series-fork'],
      widthPx: 1,
      dash: [3, 3],
      glyph: 'flag',
      label: 'Fork',
    },
    incident: {
      /** A translucent band around the moment; draw with withAlpha(color, bandAlpha). */
      color: c['series-incident'],
      bandAlpha: 0.5,
      glyphStroke: c['series-incident-stroke'],
      glyph: 'triangle',
      label: 'Incident',
    },
    preemption: {
      color: c['series-preemption'],
      glyph: 'tick',
      label: 'Preemption',
    },
    playhead: {
      color: c['series-playhead'],
      widthPx: 1.5,
      dash: [],
      glyph: 'handle',
      label: 'Playhead',
    },
  } as const;

  return { dotStyles, trackedStyle, replicaStyles, kvTankStyle, seriesStyles, markerStyles };
}

export type Encodings = ReturnType<typeof encodingsFor>;

const active = encodingsFor(colors);

// The active theme's encodings, read at draw time. refreshEncodings() rewrites them in place after
// applyTheme() changes `colors`, so hold the exported objects, not values copied out of them.
export const dotStyles = active.dotStyles;
/** Drawn around the tracked analyst's dots, with a TTFT label beside them. */
export const trackedStyle = active.trackedStyle;
export const replicaStyles = active.replicaStyles;
export const kvTankStyle = active.kvTankStyle;
export const seriesStyles = active.seriesStyles;
export const markerStyles = active.markerStyles;

export type SeriesRole = keyof Encodings['seriesStyles'];

/** Rewrites the exported encodings from the active `colors`, keeping every object's identity. */
export function refreshEncodings(): void {
  const next = encodingsFor(colors);
  for (const key of Object.keys(next) as (keyof Encodings)[]) {
    const target = active[key] as Record<string, unknown>;
    const source = next[key] as Record<string, unknown>;
    for (const [k, v] of Object.entries(source)) {
      const t = target[k];
      // A dot state, replica state, or series: copy its fields so held references stay live.
      if (v && typeof v === 'object' && !Array.isArray(v) && t && typeof t === 'object') {
        Object.assign(t, v);
      } else {
        target[k] = v;
      }
    }
  }
}
