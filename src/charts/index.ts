// Charts (00-build U4; 05 §6, §9): React SVG with d3 math. X1 mounts ChartStack in the shell's
// charts slot; U7 passes High-side rows and pending days, or uses DailyBars and NotCollectedPanel
// directly.

export { ChartStack, pendingDaysAt } from './ChartStack.tsx';
export type { ChartStackProps } from './ChartStack.tsx';
export { DailyBars, isRollupComputing, layoutBars } from './DailyBars.tsx';
export type { DailyBarsProps, RollupMetric } from './DailyBars.tsx';
export { NOT_COLLECTED_MESSAGE, NotCollectedPanel } from './NotCollectedPanel.tsx';
export type { NotCollectedPanelProps } from './NotCollectedPanel.tsx';
export { LineChart } from './LineChart.tsx';
export type { LessonMoment, LineChartProps } from './LineChart.tsx';
export {
  COLLAPSE_DURATION_MS,
  collapseDomain,
  collapsePhases,
  useCollapseProgress,
} from './collapse.ts';
export type { CollapsePhases, TimerFn } from './collapse.ts';
export {
  buildLatencyPanel,
  chooseLatencyResolution,
  MIN_LINE_POINTS,
  P99_MIN_COUNT,
} from './latency-panel.ts';
export { buildMemoryPanel } from './memory-panel.ts';
export { buildChart3Panel } from './chart3-panels.ts';
export type { Chart3Options, LoadMetric } from './chart3-panels.ts';
export { buildLivePanels } from './live-panels.ts';
export { CHART_TITLES } from './panel-types.ts';
export type {
  ChartLine,
  ChartPanel,
  ChartPoints,
  ChartTicks,
  PanelInput,
  PanelKind,
} from './panel-types.ts';
export { resolveWindow, shiftWindow, ZOOM_SPANS_MS, zoomIn, zoomOut } from './time-window.ts';
export type { ChartView, Shift } from './time-window.ts';
export { formatClock, formatMs, formatPercent, formatRate, formatRatio } from './format.ts';
