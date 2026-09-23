// Color tokens. The source of truth is the @theme block in src/index.css; this file mirrors it for
// canvas and SVG code, which cannot use classes. theme.test.ts fails if the two drift apart.
// Rationale, contrast ratios, and the colorblind checks are in ./README.md.

/** Okabe & Ito (2008), the base of every data hue. */
export const okabeIto = {
  black: '#000000',
  orange: '#E69F00',
  sky: '#56B4E9',
  green: '#009E73',
  yellow: '#F0E442',
  blue: '#0072B2',
  vermillion: '#D55E00',
  purple: '#CC79A7',
} as const;

/** UI chrome: a quiet light-gray console, with ink text and one focus blue. */
const chrome = {
  bg: '#F4F5F7',
  surface: '#FFFFFF',
  'surface-muted': '#EDF0F3',
  border: '#D3D9E0',
  'border-strong': '#7A8594',
  ink: '#151B26',
  'ink-muted': '#465162',
  'ink-subtle': '#5F6B7A',
  focus: '#1C5FD4',
  'warn-bg': '#FDF3CD',
  'warn-ink': '#5C4400',
  'warn-border': '#C9A227',
  'mode-high-side': '#5B4A91',
} as const;

/**
 * Every color token. Key `k` is the CSS variable `--color-k` and the Tailwind color `k`
 * (`bg-k`, `text-k`, `border-k`, `fill-k`, `stroke-k`).
 */
export const colors = {
  // Okabe–Ito base hues, for the rare case no semantic token fits.
  'oi-black': okabeIto.black,
  'oi-orange': okabeIto.orange,
  'oi-sky': okabeIto.sky,
  'oi-green': okabeIto.green,
  'oi-yellow': okabeIto.yellow,
  'oi-blue': okabeIto.blue,
  'oi-vermillion': okabeIto.vermillion,
  'oi-purple': okabeIto.purple,

  ...chrome,

  // Canvas: request dots (05 §7). The identifying color of each state; encodings.ts adds shape.
  'dot-queued': '#475569',
  'dot-queued-fill': chrome.surface,
  'dot-prefill': okabeIto.sky,
  'dot-prefill-stroke': '#2A6F97',
  'dot-decode': okabeIto.blue,
  'dot-decode-stroke': '#005A8C',
  'dot-preempted': okabeIto.vermillion,
  'dot-tracked': chrome.ink,

  // Canvas: replicas, KV tanks, router, aggregate flow.
  'replica-ready': chrome.surface,
  'replica-ready-stroke': chrome['border-strong'],
  'replica-loading': okabeIto.orange,
  'replica-loading-fill': '#FFF7E5',
  'replica-loading-stroke': chrome['ink-muted'],
  'replica-down': '#2B3440',
  'replica-down-hatch': '#56606E',
  'replica-down-stroke': chrome.ink,
  'replica-down-ink': chrome.surface,
  'replica-crashed-stroke': okabeIto.vermillion,
  kv: okabeIto.green,
  'kv-track': '#F0F2F5',
  'kv-stroke': chrome['border-strong'],
  'canvas-bg': chrome.surface,
  router: chrome['surface-muted'],
  flow: '#9AA5B4',

  // Charts (05 §6) and timeline markers.
  'series-mean': okabeIto.blue,
  'series-p99': okabeIto.vermillion,
  'series-secondary': okabeIto.purple,
  'series-worst': okabeIto.black,
  'series-muted': '#A3ADBA',
  'series-kv': okabeIto.green,
  'series-preemption': okabeIto.vermillion,
  'series-fork': chrome['ink-muted'],
  'series-incident': okabeIto.yellow,
  'series-incident-stroke': chrome.ink,
  'series-playhead': chrome.ink,
  'chart-grid': '#E6EAEF',
  'chart-axis': chrome['ink-subtle'],

  // High side (05 §9): daily bars, empty panels, the quiet canvas.
  'high-side-bar': '#4F6D8A',
  'high-side-bar-pending': chrome['border-strong'],
  'high-side-empty': '#F1F3F6',
  'high-side-empty-hatch': '#DDE2E8',
  'high-side-empty-ink': chrome['ink-muted'],
  'high-side-outline': chrome['border-strong'],
} as const;

export type ColorToken = keyof typeof colors;

/** `var(--color-<token>)`, for SVG attributes and React style props. */
export function cssVar(token: ColorToken): string {
  return `var(--color-${token})`;
}

/** A `#RRGGBB` color with alpha, as `rgba()`, for canvas fills such as the incident band. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
