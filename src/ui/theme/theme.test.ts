// src/index.css is the source of truth for tokens; the TS mirror must match it exactly.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colors, palettes } from './colors.ts';
import { dotStyles, replicaStyles } from './encodings.ts';
import { getTheme, setTheme } from './theme-state.ts';
import { layout } from './layout.ts';
import { fontSizes, fontStacks } from './typography.ts';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolvePath(here, '../../index.css'), 'utf8');

function block(selector: RegExp): string {
  const m = selector.exec(css);
  if (!m) throw new Error(`No block matching ${selector}`);
  return m[1];
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

const theme = declarations(block(/@theme static \{([\s\S]*?)\n\}/));
const root = declarations(block(/:root \{([\s\S]*?)\n\}/));
const darkBlock = declarations(block(/:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/));
/** The dark theme: the @theme block with the data-theme="dark" overrides on top. */
const darkTheme = new Map([...theme, ...darkBlock]);

function resolve(value: string, seen: string[] = [], vars = theme): string {
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (!ref) return value;
  const target = vars.get(ref[1]);
  if (target === undefined || seen.includes(ref[1])) throw new Error(`Bad reference ${value}`);
  return resolve(target, [...seen, ref[1]], vars);
}

const normalizeFont = (s: string) => s.replace(/["']/g, '').replace(/\s+/g, ' ').trim();

describe('tokens: src/index.css and src/ui/theme stay in sync', () => {
  const cssColors = new Map(
    [...theme]
      .filter(([name]) => name.startsWith('color-'))
      .map(([name, value]) => [name.slice('color-'.length), resolve(value).toUpperCase()]),
  );

  it('defines the same color tokens', () => {
    expect([...cssColors.keys()].sort()).toEqual(Object.keys(colors).sort());
  });

  it.each(Object.entries(colors))('--color-%s is %s', (token, hex) => {
    expect(cssColors.get(token)).toBe(hex.toUpperCase());
  });

  it('overrides only existing tokens in the dark block', () => {
    for (const name of darkBlock.keys()) expect(theme.has(name), name).toBe(true);
  });

  it.each(Object.entries(palettes.dark))('dark --color-%s is %s', (token, hex) => {
    const value = darkTheme.get(`color-${token}`);
    expect(value && resolve(value, [], darkTheme).toUpperCase()).toBe(hex.toUpperCase());
  });

  it('starts with the light palette active', () => {
    expect(colors).toEqual(palettes.light);
  });

  it('uses the same font stacks', () => {
    expect(normalizeFont(theme.get('font-sans') ?? '')).toBe(normalizeFont(fontStacks.sans));
    expect(normalizeFont(theme.get('font-mono') ?? '')).toBe(normalizeFont(fontStacks.mono));
  });

  it('uses the same 2xs size', () => {
    expect(theme.get('text-2xs')).toBe(`${fontSizes['2xs'] / 16}rem`);
  });

  it('uses the same layout sizes', () => {
    expect(root.get('layout-tabs-h')).toBe(`${layout.tabsHeightPx}px`);
    expect(root.get('layout-toolbar-h')).toBe(`${layout.toolbarHeightPx}px`);
    expect(root.get('layout-canvas-h')).toBe(`${layout.canvasHeightPx}px`);
    expect(root.get('layout-chart-h')).toBe(`${layout.chartHeightPx}px`);
    expect(root.get('layout-timeline-h')).toBe(`${layout.timelineHeightPx}px`);
  });
});

describe('setTheme', () => {
  it('switches data-theme and rewrites the canvas colors and encodings in place', () => {
    const decode = dotStyles.decode;
    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(colors).toEqual(palettes.dark);
    expect(dotStyles.decode).toBe(decode);
    expect(decode.fill).toBe(palettes.dark['dot-decode']);
    expect(replicaStyles.down.hatch?.color).toBe(palettes.dark['replica-down-hatch']);
    setTheme('light');
    expect(colors).toEqual(palettes.light);
    expect(decode.fill).toBe(palettes.light['dot-decode']);
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
