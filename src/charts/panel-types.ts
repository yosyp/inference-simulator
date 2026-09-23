// Plain view data for one live chart, built from ResultsIndex queries by the panel builders
// (latency-panel.ts, memory-panel.ts, chart3-panels.ts) and drawn by LineChart.

import type { SimMs } from '../engine/time.ts';
import type { ResultsIndex, TimeWindow } from '../playback/types.ts';
import type { Chart3Kind } from '../scenarios/schema.ts';
import type { SeriesStyle } from '../ui/theme/index.ts';

export type PanelKind = 'latency' | 'memory' | Chart3Kind;

/** Chart titles; High-side slots keep them so each slot still says what it holds. */
export const CHART_TITLES: Record<PanelKind, string> = {
  latency: 'Latency',
  memory: 'KV cache',
  utilization: 'GPU utilization',
  perReplicaLoad: 'Load per replica',
  offeredVsAdmitted: 'Offered vs. admitted',
};

/** A line over buckets [t[i], t[i] + stepMs), drawn through bucket centers. NaN is a gap. */
export interface ChartLine {
  id: string;
  /** Legend and readout label. */
  label: string;
  style: SeriesStyle;
  t: Float64Array;
  v: Float64Array;
  stepMs: number;
  /** Direct label at the line's last point, e.g. "R3, worst" (series-worst lines). */
  endLabel?: string;
  /** Listed in the legend and readout. Muted context lines are not. */
  legend: boolean;
  /** Readout only: not drawn (e.g. retry amplification, which has no axis here). */
  hidden?: boolean;
  /** Readout format when it differs from the panel's (hidden lines). */
  format?: (v: number) => string;
}

/** Individual requests, for sparse buckets (05 §6). */
export interface ChartPoints {
  id: string;
  label: string;
  shape: 'dot' | 'ring';
  color: string;
  t: Float64Array;
  v: Float64Array;
}

/** Event counts per bucket, drawn as ticks along the top of the plot (preemptions). */
export interface ChartTicks {
  id: string;
  label: string;
  color: string;
  t: Float64Array;
  v: Float64Array;
  stepMs: number;
}

export interface AxisTick {
  value: number;
  label: string;
}

export interface ChartPanel {
  kind: PanelKind;
  title: string;
  /** Back to front: context lines first, the lead line last. */
  lines: ChartLine[];
  points: ChartPoints[];
  ticks: ChartTicks | null;
  /** Log for latency, which spans milliseconds to a minute; linear from 0 otherwise. */
  yScale: 'linear' | 'log';
  yDomain: [number, number];
  yTicks: AxisTick[];
  formatValue: (v: number) => string;
  /** 'requests' when sparse buckets fall back to individual requests. */
  mode: 'lines' | 'requests';
  /** Replica drawn as the worst (highest) line, 0-based; null with one replica. */
  worstReplica: number | null;
  /** Short text beside the legend, e.g. why individual requests are shown. */
  note: string | null;
}

/** What every panel builder takes. */
export interface PanelInput {
  index: ResultsIndex;
  window: TimeWindow;
  /** Plot width in whole pixels: queries return at most this many points. */
  columns: number;
  /**
   * Data after this time is hidden: the playhead. Charts show history, never the precomputed
   * future. Buckets are drawn once complete (t + stepMs <= visibleToMs).
   */
  visibleToMs: SimMs;
}
