// Type tokens, mirrored from src/index.css (@theme --font-*). System stacks only: the production
// CSP allows fonts from 'self' and there is no font CDN (06 §5). Metrics use tabular numerals:
// the `tabular-nums` class in React, `font-variant-numeric: tabular-nums` in SVG text.

export const fontStacks = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/**
 * Type scale in CSS px. 2xs is --text-2xs in src/index.css; the rest are Tailwind's defaults.
 * Body text is sm; dense labels are xs; chart ticks are 2xs.
 */
export const fontSizes = {
  '2xs': 11,
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
} as const;

/**
 * Canvas font strings for ctx.font. Canvas has no tabular-numeral switch, so numbers that update in
 * place (TTFT labels, KV %) use the mono stack to keep their width steady.
 */
export const canvasFonts = {
  label: `500 ${fontSizes.xs}px ${fontStacks.sans}`,
  small: `${fontSizes['2xs']}px ${fontStacks.sans}`,
  numeric: `${fontSizes['2xs']}px ${fontStacks.mono}`,
} as const;
