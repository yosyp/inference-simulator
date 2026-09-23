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
  scrim: '#151B26',
} as const;

/**
 * Every color token in the light theme. Key `k` is the CSS variable `--color-k` and the Tailwind
 * color `k` (`bg-k`, `text-k`, `border-k`, `fill-k`, `stroke-k`).
 */
const light = {
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

export type ColorToken = keyof typeof light;
export type Palette = Readonly<Record<ColorToken, string>>;
export type ThemeName = 'light' | 'dark';

/** The dark theme's chrome: blue-gray surfaces, light ink, and a lighter focus blue. */
const darkChrome = {
  bg: '#0E1319',
  surface: '#161C24',
  'surface-muted': '#212933',
  border: '#343E4B',
  'border-strong': '#7F8B9A',
  ink: '#E6EBF1',
  'ink-muted': '#B6C0CC',
  'ink-subtle': '#99A4B2',
  focus: '#6FA8FF',
  'warn-bg': '#3A3016',
  'warn-ink': '#F4DE9C',
  'warn-border': '#A88A2A',
  'mode-high-side': '#A898E0',
  scrim: '#000000',
} as const;

/**
 * The dark theme (`data-theme="dark"` on <html>). Same tokens, same roles; data hues are lightened
 * where the Okabe–Ito originals fall under 3:1 on the dark canvas, and the Down replica turns
 * light so it still stands apart from the canvas and from Ready. README.md has the checks.
 */
const dark: Palette = {
  ...light,
  ...darkChrome,

  'dot-queued': '#A7B1BE',
  'dot-queued-fill': darkChrome.surface,
  'dot-prefill': okabeIto.sky,
  'dot-prefill-stroke': '#A6D7F3',
  'dot-decode': '#2F7CCB',
  'dot-decode-stroke': '#7DB5EC',
  'dot-preempted': '#F07A2E',
  'dot-tracked': darkChrome.ink,

  'replica-ready': darkChrome.surface,
  'replica-ready-stroke': darkChrome['border-strong'],
  'replica-loading': okabeIto.orange,
  'replica-loading-fill': '#2E2615',
  'replica-loading-stroke': darkChrome['ink-muted'],
  'replica-down': '#D0D7DF',
  'replica-down-hatch': '#9AA5B3',
  'replica-down-stroke': darkChrome.ink,
  'replica-down-ink': '#0E1319',
  'replica-crashed-stroke': '#CF4510',
  kv: '#1FB487',
  'kv-track': '#27303B',
  'kv-stroke': darkChrome['border-strong'],
  'canvas-bg': darkChrome.surface,
  router: darkChrome['surface-muted'],
  flow: '#5D6978',

  'series-mean': '#2F7CCB',
  'series-p99': '#F07A2E',
  'series-secondary': '#D98BB6',
  'series-worst': '#FFFFFF',
  'series-muted': '#56616F',
  'series-kv': '#1FB487',
  'series-preemption': '#F07A2E',
  'series-fork': darkChrome['ink-muted'],
  'series-incident': okabeIto.yellow,
  'series-incident-stroke': '#0E1319',
  'series-playhead': darkChrome.ink,
  'chart-grid': '#29313C',
  'chart-axis': darkChrome['ink-subtle'],

  'high-side-bar': '#86A5C4',
  'high-side-bar-pending': darkChrome['border-strong'],
  'high-side-empty': '#1B222B',
  'high-side-empty-hatch': '#2F3945',
  'high-side-empty-ink': darkChrome['ink-muted'],
  'high-side-outline': darkChrome['border-strong'],
};

/** Both themes, for tests and for switching. */
export const palettes: Readonly<Record<ThemeName, Palette>> = { light, dark };

/**
 * The active theme's colors, read at draw time by canvas code. `applyTheme` (theme-state.ts)
 * overwrites the values in place, so don't copy them into module-level constants.
 */
export const colors: Record<ColorToken, string> = { ...light };

/** `var(--color-<token>)`, for SVG attributes and React style props. */
export function cssVar(token: ColorToken): string {
  return `var(--color-${token})`;
}

/** A `#RRGGBB` color with alpha, as `rgba()`, for canvas fills such as the incident band. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
