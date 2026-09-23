// Accessibility checks behind src/ui/theme/README.md: WCAG contrast, simulated deuteranopia and
// protanopia, and a non-color cue for every state (05 §7, §10, K18).
import { describe, expect, it } from 'vitest';
import type { DotState } from '../../playback/types.ts';
import { contrastRatio, deltaE, simulateHex } from './color-math.ts';
import type { ColorToken } from './colors.ts';
import { colors, okabeIto } from './colors.ts';
import { dotStyles, replicaStyles, seriesStyles } from './encodings.ts';

/** Minimum CIE76 ΔE between colors that share a view, under every simulated vision. */
const MIN_DELTA_E = 20;
const VISIONS = ['normal', 'deuteranopia', 'protanopia'] as const;

function pairs<T>(xs: readonly T[]): [T, T][] {
  return xs.flatMap((a, i) => xs.slice(i + 1).map((b): [T, T] => [a, b]));
}

describe('color math', () => {
  it('matches known WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio(okabeIto.blue, '#FFFFFF')).toBeCloseTo(5.19, 2);
  });

  it('simulates dichromacy with Machado 2009 matrices', () => {
    // Neutral grays are fixed points; pure red loses its red-green signal.
    expect(simulateHex('#808080', 'deuteranopia')).toBe('#808080');
    expect(simulateHex('#808080', 'protanopia')).toBe('#808080');
    expect(deltaE('#FF0000', '#00FF00', 'normal')).toBeGreaterThan(100);
    // The reason dark orange is not in the palette: under deuteranopia it is vermillion.
    expect(deltaE('#AD7700', okabeIto.vermillion, 'deuteranopia')).toBeLessThan(5);
  });
});

describe('text contrast (WCAG AA, 4.5:1)', () => {
  const text: [ColorToken, ColorToken][] = [
    ['ink', 'bg'],
    ['ink', 'surface'],
    ['ink', 'surface-muted'],
    ['ink-muted', 'bg'],
    ['ink-muted', 'surface'],
    ['ink-muted', 'surface-muted'],
    ['ink-subtle', 'bg'],
    ['ink-subtle', 'surface'],
    ['ink-subtle', 'surface-muted'],
    ['surface', 'ink'],
    ['surface', 'mode-high-side'],
    ['warn-ink', 'warn-bg'],
    ['chart-axis', 'surface'],
    ['replica-down-ink', 'replica-down'],
    ['high-side-empty-ink', 'high-side-empty'],
    ['ink', 'replica-loading-fill'],
  ];
  it.each(text)('%s on %s', (fg, bg) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('graphics and control contrast (WCAG 1.4.11, 3:1)', () => {
  const graphics: [ColorToken, ColorToken][] = [
    ['border-strong', 'surface'],
    ['border-strong', 'bg'],
    ['focus', 'bg'],
    ['focus', 'surface'],
    ['focus', 'surface-muted'],
    ['mode-high-side', 'bg'],
    // Dot edges against the canvas.
    ['dot-queued', 'canvas-bg'],
    ['dot-prefill-stroke', 'canvas-bg'],
    ['dot-decode', 'canvas-bg'],
    ['dot-preempted', 'canvas-bg'],
    ['dot-tracked', 'canvas-bg'],
    // Replica outlines and the KV tank.
    ['replica-ready-stroke', 'canvas-bg'],
    ['replica-loading-stroke', 'canvas-bg'],
    ['replica-down', 'canvas-bg'],
    ['replica-crashed-stroke', 'canvas-bg'],
    ['replica-crashed-stroke', 'replica-down'],
    ['kv-stroke', 'canvas-bg'],
    ['kv', 'kv-track'],
    // Chart lines and markers.
    ['series-mean', 'surface'],
    ['series-p99', 'surface'],
    ['series-secondary', 'surface'],
    ['series-worst', 'surface'],
    ['series-kv', 'surface'],
    ['series-preemption', 'surface'],
    ['series-fork', 'surface'],
    ['series-incident-stroke', 'series-incident'],
    ['series-playhead', 'surface'],
    ['high-side-bar', 'surface'],
    ['high-side-bar-pending', 'surface'],
    ['high-side-outline', 'surface'],
  ];
  it.each(graphics)('%s against %s', (fg, bg) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe('colorblind separation', () => {
  const dotStates = Object.keys(dotStyles) as DotState[];
  const dotColor = (s: DotState) => dotStyles[s].fill ?? dotStyles[s].stroke;
  // The queued dot is identified by its outline, not its white fill.
  const identifying = (s: DotState) => (s === 'queued' ? dotStyles[s].stroke : dotColor(s));

  describe.each(VISIONS)('%s', (vision) => {
    it.each(pairs(dotStates))('dot %s vs %s', (a, b) => {
      expect(deltaE(identifying(a), identifying(b), vision)).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });

    // Lines that can share a chart: chart 1 (latency) and chart 2 (memory).
    const chart1 = ['mean', 'p99', 'secondary', 'worst'] as const;
    const chart2 = ['kv', 'worst'] as const;
    const chartPairs: [string, string][] = [
      ...pairs(chart1.map((r) => seriesStyles[r].color)),
      ...pairs(chart2.map((r) => seriesStyles[r].color)),
      [colors['series-kv'], colors['series-preemption']],
      [colors['series-worst'], colors['series-preemption']],
    ];
    it.each(chartPairs)('series %s vs %s', (a, b) => {
      expect(deltaE(a, b, vision)).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });

    it('Crashed and Down borders differ', () => {
      expect(
        deltaE(replicaStyles.crashed.stroke, replicaStyles.down.stroke, vision),
      ).toBeGreaterThanOrEqual(MIN_DELTA_E);
    });
  });
});

describe('non-color cues', () => {
  it('gives every dot state a distinct shape, size, or fill', () => {
    const signatures = Object.values(dotStyles).map(
      (s) => `${s.shape}|${s.radiusPx}|${s.fill === null ? 'hollow' : 'filled'}`,
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('draws queued smaller and outlined, preempted as a hollow ring', () => {
    const others = [dotStyles.prefill, dotStyles.decode, dotStyles.preempted];
    expect(dotStyles.queued.radiusPx).toBeLessThan(Math.min(...others.map((s) => s.radiusPx)));
    expect(dotStyles.preempted.shape).toBe('ring');
    expect(dotStyles.preempted.fill).toBeNull();
  });

  it('gives Ready, Down, and Loading distinct outlines, fills, or hatching', () => {
    const { ready, down, crashed, loadingWeights, initializingEngine } = replicaStyles;
    // Down and Crashed: dark and hatched. Ready: light and plain. Loading: dashed with progress.
    expect(down.hatch).not.toBeNull();
    expect(crashed.hatch).not.toBeNull();
    expect(ready.hatch).toBeNull();
    expect(contrastRatio(ready.fill, down.fill)).toBeGreaterThanOrEqual(3);
    for (const loading of [loadingWeights, initializingEngine]) {
      expect(loading.dash.length).toBeGreaterThan(0);
      expect(loading.progress).not.toBeNull();
    }
    expect(ready.dash).toHaveLength(0);
    // Crashed differs from Down by a heavier border as well as its hue.
    expect(crashed.strokeWidthPx).toBeGreaterThan(down.strokeWidthPx);
    // Every state has its own label, the last-resort cue.
    const labels = Object.values(replicaStyles).map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('separates lines that share chart 1 by dash or width as well as hue', () => {
    const { mean, p99, secondary } = seriesStyles;
    const signature = (s: { widthPx: number; dash: readonly number[] }) =>
      `${s.widthPx}|${s.dash.join(',')}`;
    expect(new Set([mean, p99, secondary].map(signature)).size).toBe(3);
  });
});
