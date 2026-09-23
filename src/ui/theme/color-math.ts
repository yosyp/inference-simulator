// Color checks behind README.md: WCAG 2.x contrast, and dichromacy simulation with the Machado,
// Oliveira & Fernandes (2009) matrices at severity 1.0, applied in linear sRGB. Distances are CIE76
// ΔE in CIELAB (D65). Used by palette.test.ts; cheap enough for a legend to call at runtime.

export type Rgb = readonly [number, number, number];
export type Vision = 'normal' | 'deuteranopia' | 'protanopia';

/** `#RRGGBB` to sRGB channels in 0..1. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Expected #RRGGBB, got ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: string): Rgb {
  const [r, g, b] = hexToRgb(hex);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

type Matrix = readonly [Rgb, Rgb, Rgb];

const MACHADO: Record<Exclude<Vision, 'normal'>, Matrix> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The color as seen under `vision`, in linear sRGB. */
export function simulateLinear(hex: string, vision: Vision): Rgb {
  const v = linearRgb(hex);
  if (vision === 'normal') return v;
  const m = MACHADO[vision];
  const row = (r: Rgb) => clamp01(r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  return [row(m[0]), row(m[1]), row(m[2])];
}

/** The color as seen under `vision`, as `#RRGGBB`. */
export function simulateHex(hex: string, vision: Vision): string {
  const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const byte = (c: number) =>
    Math.round(clamp01(toSrgb(c)) * 255)
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = simulateLinear(hex, vision);
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

/** Linear sRGB to CIELAB (D65). */
export function linearToLab([r, g, b]: Rgb): Rgb {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE between two colors as seen under `vision`. */
export function deltaE(a: string, b: string, vision: Vision = 'normal'): number {
  const la = linearToLab(simulateLinear(a, vision));
  const lb = linearToLab(simulateLinear(b, vision));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
