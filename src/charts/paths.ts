// SVG path strings from series data, with d3-shape. React renders the strings (K13).

import { line as d3Line } from 'd3-shape';

type Pt = [number, number];

const generator = d3Line<Pt>().defined((d) => Number.isFinite(d[0]) && Number.isFinite(d[1]));

/**
 * A line through bucket centers, broken at gaps (non-finite values or y). At most one vertex per
 * pixel column: when two points land in the same column, the higher one (smaller y) is kept, so
 * a path never has more vertices than the plot has columns, whatever the data resolution.
 */
export function linePath(
  t: ArrayLike<number>,
  v: ArrayLike<number>,
  stepMs: number,
  x: (ms: number) => number,
  y: (value: number) => number,
): string {
  const pts: Pt[] = [];
  let lastCol = NaN;
  for (let i = 0; i < t.length; i++) {
    const px = x(t[i]! + stepMs / 2);
    const py = Number.isFinite(v[i]!) ? y(v[i]!) : NaN;
    if (!Number.isFinite(py)) {
      pts.push([px, NaN]);
      lastCol = NaN;
      continue;
    }
    const col = Math.floor(px);
    const prev = pts[pts.length - 1];
    if (col === lastCol && prev) {
      if (py < prev[1]) pts[pts.length - 1] = [px, py];
      continue;
    }
    lastCol = col;
    pts.push([px, py]);
  }
  return generator(pts) ?? '';
}

/** Vertices in a path string (M and L commands). */
export function pathVertexCount(d: string): number {
  return (d.match(/[ML]/g) ?? []).length;
}

/**
 * A bar with 4 px rounded data-end corners and a square base, from baseline y0 up to y1
 * (y1 < y0 in SVG coordinates).
 */
export function barPath(x: number, width: number, y0: number, y1: number, radius = 4): string {
  const h = y0 - y1;
  if (!(h > 0) || !(width > 0)) return '';
  const r = Math.min(radius, width / 2, h);
  return [
    `M${x},${y0}`,
    `V${y1 + r}`,
    `Q${x},${y1} ${x + r},${y1}`,
    `H${x + width - r}`,
    `Q${x + width},${y1} ${x + width},${y1 + r}`,
    `V${y0}`,
    'Z',
  ].join('');
}
