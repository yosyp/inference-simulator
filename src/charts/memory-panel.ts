// Chart 2, memory (05 §6): KV cache use (kvUsedFrac) with preemption markers.
//
// The fleet/worst rule, shared with per-replica load: the fleet line leads in its own color; with
// two or more replicas, the replica with the highest average over the visible part of the window
// is drawn in black with a direct label, and the others are thin muted context lines. It stays
// readable at 8 replicas because only two lines carry color.

import { FLEET_SERIES, replicaSeries, type ScalarMetric } from '../engine/results.ts';
import type { SeriesData } from '../playback/types.ts';
import { formatPercent, percentTickFormat } from './format.ts';
import {
  CHART_TITLES,
  type ChartLine,
  type ChartPanel,
  type ChartTicks,
  type PanelInput,
} from './panel-types.ts';
import { clipComplete, finiteMean, pickWorst, unitAxis } from './series.ts';
import { lineStyles, markers, replicaLabel } from './styles.ts';

export interface ReplicaLines {
  lines: ChartLine[];
  worst: number | null;
}

/**
 * Per-replica context lines plus the highlighted worst replica, for any per-replica level.
 * `values(series)` returns a replica's series; `word` completes the direct label ("R3, highest").
 */
export function replicaLines(
  input: PanelInput,
  values: (series: number) => SeriesData,
  opts: { word: string; label: string },
): ReplicaLines {
  const { index, visibleToMs } = input;
  if (index.replicas < 2) return { lines: [], worst: null };
  const clipped = [...Array(index.replicas).keys()].map((r) => {
    const s = values(replicaSeries(r));
    return { ...clipComplete(s.t, s.v, s.stepMs, visibleToMs), stepMs: s.stepMs };
  });
  const worst = pickWorst(clipped.map((c) => finiteMean(c.v)));
  const lines: ChartLine[] = [];
  clipped.forEach((c, r) => {
    if (r === worst) return;
    lines.push({
      id: `replica${r}`,
      label: replicaLabel(r),
      style: lineStyles.muted,
      ...c,
      legend: false,
    });
  });
  if (worst !== null) {
    const name = replicaLabel(worst);
    lines.push({
      id: 'worst',
      label: `${name} ${opts.label}`,
      style: lineStyles.worst,
      ...clipped[worst]!,
      legend: true,
      endLabel: `${name}, ${opts.word}`,
    });
  }
  return { lines, worst };
}

function series(input: PanelInput, metric: ScalarMetric, s: number): SeriesData {
  return input.index.scalarSeries(metric, s, input.window, input.columns);
}

export function buildMemoryPanel(input: PanelInput): ChartPanel {
  const { visibleToMs } = input;
  const fleet = series(input, 'kvUsedFrac', FLEET_SERIES);
  const { lines, worst } = replicaLines(input, (s) => series(input, 'kvUsedFrac', s), {
    word: 'highest',
    label: 'KV (highest)',
  });
  lines.push({
    id: 'kv',
    label: input.index.replicas > 1 ? 'KV used, fleet' : 'KV used',
    style: lineStyles.kv,
    ...clipComplete(fleet.t, fleet.v, fleet.stepMs, visibleToMs),
    stepMs: fleet.stepMs,
    legend: true,
  });
  const pre = series(input, 'preemptions', FLEET_SERIES);
  const ticks: ChartTicks = {
    id: 'preemptions',
    label: markers.preemption.label + 's',
    color: markers.preemption.color,
    ...clipComplete(pre.t, pre.v, pre.stepMs, visibleToMs),
    stepMs: pre.stepMs,
  };
  const axis = unitAxis(percentTickFormat());
  return {
    kind: 'memory',
    title: CHART_TITLES.memory,
    lines,
    points: [],
    ticks,
    yScale: 'linear',
    yDomain: axis.domain,
    yTicks: axis.ticks,
    formatValue: formatPercent,
    mode: 'lines',
    worstReplica: worst,
    note: null,
  };
}
