// The active color theme. It starts from prefers-color-scheme and follows it until the visitor picks
// one; the pick lives in memory only (the app uses no browser storage). Applying a theme sets
// data-theme on <html>, which switches the CSS variables (src/index.css), and rewrites the canvas
// mirror (`colors` and the encodings) in place.

import { useSyncExternalStore } from 'react';
import { colors, palettes, type ThemeName } from './colors.ts';
import { refreshEncodings } from './encodings.ts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

let current: ThemeName = 'light';
let chosen = false;
const listeners = new Set<() => void>();

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null;
}

function apply(name: ThemeName): void {
  current = name;
  Object.assign(colors, palettes[name]);
  refreshEncodings();
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = name;
  for (const l of listeners) l();
}

/** The theme in effect. */
export function getTheme(): ThemeName {
  return current;
}

/** Switches theme; the choice then overrides prefers-color-scheme for the page's lifetime. */
export function setTheme(name: ThemeName): void {
  chosen = true;
  if (name !== current || document.documentElement.dataset.theme !== name) apply(name);
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let initialized = false;

/** Applies the system preference and follows its changes until setTheme. Idempotent. */
export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  const query = darkQuery();
  apply(query?.matches ? 'dark' : 'light');
  query?.addEventListener('change', (e) => {
    if (!chosen) apply(e.matches ? 'dark' : 'light');
  });
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme);
}
