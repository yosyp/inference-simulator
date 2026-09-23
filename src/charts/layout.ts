// Chart geometry. Every chart, the daily bars, and the time axis share the same horizontal insets,
// so one x pixel is the same moment in all of them (05 §6).

import { layout } from '../ui/theme/index.ts';

/** Horizontal insets of the plot area: y tick labels on the left, room for end labels on the right. */
export const PLOT_INSET = { left: 52, right: 20 } as const;

/** Vertical padding inside each chart's SVG: marker glyphs sit in the top pad. */
export const PLOT_PAD = { top: 9, bottom: 3 } as const;

/** Rows inside the stack. The three charts share what is left of 3 × layout.chartHeightPx. */
export const STACK_ROWS = {
  toolbarPx: 24,
  /** Title and legend (the readout) above each chart. */
  headerPx: 18,
  axisPx: 18,
} as const;

/** Used until the container has been measured (jsdom, first render). */
export const FALLBACK_WIDTH_PX = 960;

export interface StackGeometry {
  width: number;
  plotWidth: number;
  /** Whole pixel columns in the plot: the `columns` passed to index queries. */
  columns: number;
  /** One chart including its header. */
  chartHeight: number;
  /** The chart's SVG. */
  svgHeight: number;
  plotHeight: number;
  totalHeight: number;
}

export function stackGeometry(
  width: number,
  totalHeight = 3 * layout.chartHeightPx,
): StackGeometry {
  const plotWidth = Math.max(1, width - PLOT_INSET.left - PLOT_INSET.right);
  const chartHeight = Math.floor((totalHeight - STACK_ROWS.toolbarPx - STACK_ROWS.axisPx) / 3);
  const svgHeight = chartHeight - STACK_ROWS.headerPx;
  return {
    width,
    plotWidth,
    columns: Math.max(1, Math.floor(plotWidth)),
    chartHeight,
    svgHeight,
    plotHeight: Math.max(1, svgHeight - PLOT_PAD.top - PLOT_PAD.bottom),
    totalHeight,
  };
}
