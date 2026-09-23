// Layout tokens (05 §1, K15), mirrored from the --layout-* variables in src/index.css.
// At the 1440×900 design target the whole stack fits without scrolling:
// tabs 44 + toolbar 48 + canvas 272 + 3 charts × 132 + timeline 72 = 832 px, plus borders.

export const viewport = {
  designWidthPx: 1440,
  designHeightPx: 900,
  /** Below either minimum the shell shows a "use a larger window" notice (K15). */
  minWidthPx: 1280,
  minHeightPx: 720,
} as const;

export const layout = {
  /** Simulator column share of the width; the sidebar takes the rest. */
  simulatorFraction: 0.7,
  tabsHeightPx: 44,
  toolbarHeightPx: 48,
  canvasHeightPx: 272,
  /** Height of one chart; the charts slot stacks three. */
  chartHeightPx: 132,
  timelineHeightPx: 72,
} as const;

export function isViewportTooSmall(widthPx: number, heightPx: number): boolean {
  return widthPx < viewport.minWidthPx || heightPx < viewport.minHeightPx;
}
