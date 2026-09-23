// Chart 3, per tab (05 §6):
// - utilization (tabs 1–3): nvidia-smi-style = busyMs ÷ step, and compute = flops ÷ (peak × step),
//   with peak = calibration.gpu.peakDenseFp16Flops (the engine's definitions in cost/utilization.ts).
//   Fleet values average over all replicas.
// - perReplicaLoad (tabs 4–5): outstanding requests per replica (router view: dispatched, not
//   finished), or running + waiting (engine view), with the fleet/worst rule from memory-panel.ts.
//   The fleet line is the average per Ready replica, the same basis as fleet KV %.
// - offeredVsAdmitted (tab 6): offered (arrivals, retries included) vs. admitted (dispatched), plus
//   rejects, per second, and retry amplification = offered ÷ first attempts (organic).

import type { Calibration } from '../engine/calibration.ts';
import { FLEET_SERIES, type ScalarMetric } from '../engine/results.ts';
import type { SeriesData } from '../playback/types.ts';
import type { Chart3Kind } from '../scenarios/schema.ts';
import {
  formatCount,
  formatPercent,
  formatRate,
  formatRatio,
  percentTickFormat,
  plainTickFormat,
} from './format.ts';
import { replicaLines } from './memory-panel.ts';
import { CHART_TITLES, type ChartLine, type ChartPanel, type PanelInput } from './panel-types.ts';
import {
  add,
  clipComplete,
  divide,
  finiteSum,
  maxOf,
  perSecond,
  scaleBy,
  unitAxis,
  zeroBasedAxis,
} from './series.ts';
import { lineStyles } from './styles.ts';

export type LoadMetric = 'outstanding' | 'runningPlusWaiting';

export interface Chart3Options {
  calibration: Calibration;
  /** perReplicaLoad only. Default 'outstanding'. */
  loadMetric?: LoadMetric;
}

function query(input: PanelInput, metric: ScalarMetric, s = FLEET_SERIES): SeriesData {
  return input.index.scalarSeries(metric, s, input.window, input.columns);
}

function line(
  input: PanelInput,
  id: string,
  label: string,
  style: ChartLine['style'],
  base: SeriesData,
  v: Float64Array,
): ChartLine {
  return {
    id,
    label,
    style,
    ...clipComplete(base.t, v, base.stepMs, input.visibleToMs),
    stepMs: base.stepMs,
    legend: true,
  };
}

function panel(
  kind: Chart3Kind,
  title: string,
  lines: ChartLine[],
  axis: { domain: [number, number]; ticks: ChartPanel['yTicks'] },
  formatValue: (v: number) => string,
  extra: Partial<ChartPanel> = {},
): ChartPanel {
  return {
    kind,
    title,
    lines,
    points: [],
    ticks: null,
    yScale: 'linear',
    yDomain: axis.domain,
    yTicks: axis.ticks,
    formatValue,
    mode: 'lines',
    worstReplica: null,
    note: null,
    ...extra,
  };
}

export function buildUtilizationPanel(input: PanelInput, calibration: Calibration): ChartPanel {
  const replicas = Math.max(1, input.index.replicas);
  const busy = query(input, 'busyMs');
  const flops = query(input, 'flops');
  const busyFrac = scaleBy(busy.v, 1 / (busy.stepMs * replicas));
  const peakPerBucket = calibration.gpu.peakDenseFp16Flops * (flops.stepMs / 1000) * replicas;
  const computeFrac = scaleBy(flops.v, 1 / peakPerBucket);
  return panel(
    'utilization',
    CHART_TITLES.utilization,
    [
      line(input, 'nvidiaSmi', 'Busy (nvidia-smi)', lineStyles.secondary, busy, busyFrac),
      line(input, 'compute', 'Compute (FLOPs ÷ peak)', lineStyles.mean, flops, computeFrac),
    ],
    unitAxis(percentTickFormat()),
    formatPercent,
  );
}

export function buildLoadPanel(input: PanelInput, metric: LoadMetric = 'outstanding'): ChartPanel {
  const values = (s: number): SeriesData => {
    if (metric === 'outstanding') return query(input, 'outstanding', s);
    const running = query(input, 'running', s);
    return { ...running, v: add(running.v, query(input, 'waiting', s).v) };
  };
  const what = metric === 'outstanding' ? 'Outstanding requests' : 'Running + waiting';
  const { lines, worst } = replicaLines(input, values, { word: 'busiest', label: '(busiest)' });
  const fleet = values(FLEET_SERIES);
  if (input.index.replicas > 1) {
    const ready = query(input, 'readyReplicas');
    lines.push(
      line(input, 'fleet', 'Fleet average', lineStyles.mean, fleet, divide(fleet.v, ready.v)),
    );
  } else {
    lines.push(line(input, 'fleet', what, lineStyles.mean, fleet, fleet.v));
  }
  const axis = zeroBasedAxis(maxOf(lines.map((l) => l.v)), 4, () => plainTickFormat());
  return panel('perReplicaLoad', CHART_TITLES.perReplicaLoad, lines, axis, formatCount, {
    worstReplica: worst,
    note: input.index.replicas > 1 ? `${what} per replica` : null,
  });
}

export function buildOfferedPanel(input: PanelInput): ChartPanel {
  const offered = query(input, 'offered');
  const organic = query(input, 'organic');
  const dispatched = query(input, 'dispatched');
  const rejected = query(input, 'rejected');
  const amp = line(
    input,
    'amplification',
    'Amplification',
    lineStyles.muted,
    offered,
    divide(offered.v, organic.v),
  );
  // Offered is dashed and drawn over admitted, so both show where they coincide (no retries).
  const lines = [
    line(input, 'rejected', 'Rejected', lineStyles.rejected, rejected, perSecond(rejected)),
    line(input, 'admitted', 'Admitted', lineStyles.mean, dispatched, perSecond(dispatched)),
    line(input, 'offered', 'Offered', lineStyles.secondary, offered, perSecond(offered)),
    { ...amp, hidden: true, format: formatRatio },
  ];
  const visibleOrganic = finiteSum(
    clipComplete(organic.t, organic.v, organic.stepMs, input.visibleToMs).v,
  );
  const visibleOffered = finiteSum(
    clipComplete(offered.t, offered.v, offered.stepMs, input.visibleToMs).v,
  );
  const windowAmp = visibleOrganic > 0 ? visibleOffered / visibleOrganic : NaN;
  const axis = zeroBasedAxis(maxOf(lines.filter((l) => !l.hidden).map((l) => l.v)), 1, () =>
    plainTickFormat('/s'),
  );
  return panel('offeredVsAdmitted', CHART_TITLES.offeredVsAdmitted, lines, axis, formatRate, {
    note: Number.isFinite(windowAmp) ? `${formatRatio(windowAmp)} amplification in view` : null,
  });
}

export function buildChart3Panel(
  kind: Chart3Kind,
  input: PanelInput,
  opts: Chart3Options,
): ChartPanel {
  switch (kind) {
    case 'utilization':
      return buildUtilizationPanel(input, opts.calibration);
    case 'perReplicaLoad':
      return buildLoadPanel(input, opts.loadMetric);
    case 'offeredVsAdmitted':
      return buildOfferedPanel(input);
  }
}
