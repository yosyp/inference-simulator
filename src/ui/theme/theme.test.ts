// src/index.css is the source of truth for tokens; the TS mirror must match it exactly.
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colors } from './colors.ts';
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

function resolve(value: string, seen: string[] = []): string {
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  if (!ref) return value;
  const target = theme.get(ref[1]);
  if (target === undefined || seen.includes(ref[1])) throw new Error(`Bad reference ${value}`);
  return resolve(target, [...seen, ref[1]]);
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
