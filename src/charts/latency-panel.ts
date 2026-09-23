// Chart 1, latency (05 §6, K14): TTFT p99 leads, TTFT mean beside it, E2E p99 as a thinner
// secondary line. Multi-replica tabs add the worst replica's TTFT p99 in black, where "worst" is the
// replica with the highest p99 over the visible part of the window.
//
// Percentiles come from the index's merged histograms (E9's quantile), never recomputed here. The
// mean is ttftSumMs ÷ ttftCount per point, so it is exact at any zoom.
//
// The y axis is logarithmic. Latency here spans ~50 ms at idle to a 60 s timeout, and E2E p99 sits
// 10–100× above TTFT (it includes the whole output), so on a linear axis E2E would flatten the
// TTFT lines the chart leads with (K14). On a log axis the p99-to-mean gap is their ratio, which is
// what diverges at the knee.
//
// Sparse buckets. A p99 over fewer than P99_MIN_COUNT requests is little more than the largest one,
// so when the median non-empty point holds fewer, the chart first widens its points (fewer columns)
// until a typical point holds P99_MIN_COUNT. If that leaves fewer than MIN_LINE_POINTS across the
// window, it plots individual requests from requestPoints instead (tab 1 has one analyst). The
// decision uses the whole window, including computed time after the playhead, so the chart doesn't
// switch modes while it plays; only the values drawn stop at the playhead.

import { FLEET_SERIES, replicaSeries } from '../engine/results.ts';
import type { QuantileData, RequestPoints, TimeWindow } from '../playback/types.ts';
import { formatMs } from './format.ts';
import {
  CHART_TITLES,
  type ChartLine,
  type ChartPanel,
  type ChartPoints,
  type PanelInput,
} from './panel-types.ts';
import {
  clipComplete,
  decimatePerColumn,
  divide,
  finiteMax,
  logMsAxis,
  median,
  pickWorst,
} from './series.ts';
import { lineStyles, replicaLabel } from './styles.ts';

/** Requests per point for a stable p99. Below it the chart widens points or plots requests. */
export const P99_MIN_COUNT = 50;
/** Fewest points a widened p99 line may have across the window before the chart plots requests. */
export const MIN_LINE_POINTS = 12;

export type LatencyResolution = { mode: 'lines'; columns: number } | { mode: 'requests' };

/**
 * Chooses how to draw latency from per-point request counts at full resolution: lines at `columns`,
 * lines at fewer columns, or individual requests.
 */
export function chooseLatencyResolution(
  counts: ArrayLike<number>,
  columns: number,
): LatencyResolution {
  const nonEmpty = Array.from(counts).filter((c) => c > 0);
  if (nonEmpty.length === 0) return { mode: 'lines', columns };
  const typical = median(nonEmpty);
  if (typical >= P99_MIN_COUNT) return { mode: 'lines', columns };
  const merge = Math.ceil(P99_MIN_COUNT / typical);
  const points = Math.floor(Math.min(counts.length, columns) / merge);
  return points >= MIN_LINE_POINTS ? { mode: 'lines', columns: points } : { mode: 'requests' };
}

/** [window start, min(window end, visibleToMs)). */
export function visiblePart(window: TimeWindow, visibleToMs: number): TimeWindow {
  return {
    fromMs: window.fromMs,
    toMs: Math.max(window.fromMs, Math.min(window.toMs, visibleToMs)),
  };
}

function p99Line(
  id: string,
  label: string,
  q: QuantileData,
  style: ChartLine['style'],
  visibleToMs: number,
): ChartLine {
  const { t, v } = clipComplete(q.t, q.values[0]!, q.stepMs, visibleToMs);
  return { id, label, style, t, v, stepMs: q.stepMs, legend: true };
}

/** The replica with the highest TTFT p99 over `visible`, from one merged histogram per replica. */
export function worstLatencyReplica(input: PanelInput): number | null {
  const { index } = input;
  const visible = visiblePart(input.window, input.visibleToMs);
  if (index.replicas < 2 || visible.toMs <= visible.fromMs) return null;
  const scores: number[] = [];
  for (let r = 0; r < index.replicas; r++) {
    scores.push(
      finiteMax(index.quantileSeries('ttft', replicaSeries(r), visible, 1, [0.99]).values[0]!),
    );
  }
  return pickWorst(scores);
}

export function buildLatencyPanel(input: PanelInput): ChartPanel {
  const { index, window, columns, visibleToMs } = input;
  const probe = index.quantileSeries('ttft', FLEET_SERIES, window, columns, [0.99]);
  const resolution = chooseLatencyResolution(probe.counts, columns);
  if (resolution.mode === 'requests') {
    const pts = index.requestPoints(window);
    if (pts.t.length > 0) return requestsPanel(input, pts);
  }
  const cols = resolution.mode === 'lines' ? resolution.columns : columns;
  const q =
    cols === columns ? probe : index.quantileSeries('ttft', FLEET_SERIES, window, cols, [0.99]);
  const sum = index.scalarSeries('ttftSumMs', FLEET_SERIES, window, cols);
  const count = index.scalarSeries('ttftCount', FLEET_SERIES, window, cols);
  const e2e = index.quantileSeries('e2e', FLEET_SERIES, window, cols, [0.99]);

  const mean = clipComplete(sum.t, divide(sum.v, count.v), sum.stepMs, visibleToMs);
  const lines: ChartLine[] = [p99Line('e2eP99', 'E2E p99', e2e, lineStyles.secondary, visibleToMs)];
  const worst = worstLatencyReplica(input);
  if (worst !== null) {
    const wq = index.quantileSeries('ttft', replicaSeries(worst), window, cols, [0.99]);
    const label = replicaLabel(worst);
    lines.push({
      ...p99Line('worstP99', `${label} p99 (worst)`, wq, lineStyles.worst, visibleToMs),
      endLabel: `${label}, worst`,
    });
  }
  lines.push(
    {
      id: 'ttftMean',
      label: 'TTFT mean',
      style: lineStyles.mean,
      ...mean,
      stepMs: sum.stepMs,
      legend: true,
    },
    p99Line('ttftP99', 'TTFT p99', q, lineStyles.p99, visibleToMs),
  );
  const axis = logMsAxis(lines.flatMap((l) => Array.from(l.v)));
  return {
    kind: 'latency',
    title: CHART_TITLES.latency,
    lines,
    points: [],
    ticks: null,
    yScale: 'log',
    yDomain: axis.domain,
    yTicks: axis.ticks,
    formatValue: formatMs,
    mode: 'lines',
    worstReplica: worst,
    note: cols < columns ? 'Wider p99 buckets: few requests per pixel' : null,
  };
}

function requestsPanel(input: PanelInput, pts: RequestPoints): ChartPanel {
  const { window, columns, visibleToMs } = input;
  const span = Math.max(1, window.toMs - window.fromMs);
  const toPx = (ms: number) => ((ms - window.fromMs) / span) * columns;
  // Requests keyed inside the visible part of the window, in time order.
  const order = Array.from(pts.t.keys())
    .filter(
      (i) => pts.t[i]! >= window.fromMs && pts.t[i]! < window.toMs && pts.t[i]! <= visibleToMs,
    )
    .sort((a, b) => pts.t[a]! - pts.t[b]!);
  const pick = (values: Float64Array) =>
    decimatePerColumn(
      order.map((i) => pts.t[i]!),
      order.map((i) => values[i]!),
      toPx,
    );
  const ttft = pick(pts.ttftMs);
  const e2e = pick(pts.e2eMs);
  const points: ChartPoints[] = [
    {
      id: 'e2eRequests',
      label: 'E2E, each request',
      shape: 'ring',
      color: lineStyles.secondary.color,
      ...e2e,
    },
    {
      id: 'ttftRequests',
      label: 'TTFT, each request',
      shape: 'dot',
      color: lineStyles.mean.color,
      ...ttft,
    },
  ];
  const axis = logMsAxis([...ttft.v, ...e2e.v]);
  return {
    kind: 'latency',
    title: CHART_TITLES.latency,
    lines: [],
    points,
    ticks: null,
    yScale: 'log',
    yDomain: axis.domain,
    yTicks: axis.ticks,
    formatValue: formatMs,
    mode: 'requests',
    worstReplica: null,
    note: 'Too few requests for a p99: each mark is one request',
  };
}
