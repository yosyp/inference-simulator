// The three live panels for one window.

import type { Calibration } from '../engine/calibration.ts';
import type { ResultsIndex } from '../playback/types.ts';
import type { Chart3Kind } from '../scenarios/schema.ts';
import { buildChart3Panel, type LoadMetric } from './chart3-panels.ts';
import { buildLatencyPanel } from './latency-panel.ts';
import { buildMemoryPanel } from './memory-panel.ts';
import type { ChartPanel, PanelInput } from './panel-types.ts';

export interface LivePanelsArgs {
  index: ResultsIndex;
  /** index.version when built: the memo key for new data. */
  version: number;
  fromMs: number;
  toMs: number;
  columns: number;
  visibleToMs: number;
  chart3: Chart3Kind;
  calibration: Calibration;
  loadMetric: LoadMetric;
}

export function buildLivePanels(a: LivePanelsArgs): [ChartPanel, ChartPanel, ChartPanel] {
  const input: PanelInput = {
    index: a.index,
    window: { fromMs: a.fromMs, toMs: a.toMs },
    columns: a.columns,
    visibleToMs: a.visibleToMs,
  };
  return [
    buildLatencyPanel(input),
    buildMemoryPanel(input),
    buildChart3Panel(a.chart3, input, { calibration: a.calibration, loadMetric: a.loadMetric }),
  ];
}
