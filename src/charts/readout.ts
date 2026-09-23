// The legend doubles as the readout (values lead, labels follow): each entry shows its value at the
// hover cursor, or the latest visible value when there is no cursor.

import type { SimMs } from '../engine/time.ts';
import { formatClock, formatCount } from './format.ts';
import type { ChartLine, ChartPanel, ChartPoints } from './panel-types.ts';
import { finiteSum, lastFinite, nearestIndex, valueAt } from './series.ts';

export type Swatch =
  | { kind: 'line'; style: ChartLine['style'] }
  | { kind: 'dot' | 'ring'; color: string }
  | { kind: 'tick'; color: string }
  | { kind: 'bar'; color: string }
  /** Readout-only values (retry amplification). */
  | { kind: 'none' };

export interface LegendEntry {
  id: string;
  label: string;
  value: string;
  swatch: Swatch;
}

/** How close (in pixels) the cursor must be to a request to read it. */
export const POINT_PICK_PX = 6;

function lineValue(line: ChartLine, cursorMs: SimMs | null): number {
  return cursorMs === null ? lastFinite(line.v) : valueAt(line.t, line.v, line.stepMs, cursorMs);
}

function pointValue(points: ChartPoints, cursorMs: SimMs | null, pixelMs: number): number {
  if (cursorMs === null) return lastFinite(points.v);
  const i = nearestIndex(points.t, cursorMs, POINT_PICK_PX * pixelMs);
  return i < 0 ? NaN : points.v[i]!;
}

/**
 * Legend entries in reading order (the lead series first). `pixelMs` is the time one pixel spans,
 * for picking individual requests near the cursor.
 */
export function legendEntries(
  panel: ChartPanel,
  cursorMs: SimMs | null,
  pixelMs: number,
): LegendEntry[] {
  const out: LegendEntry[] = [];
  const ordered = [...panel.lines].reverse();
  for (const line of [...ordered.filter((l) => !l.hidden), ...ordered.filter((l) => l.hidden)]) {
    if (!line.legend) continue;
    const format = line.format ?? panel.formatValue;
    out.push({
      id: line.id,
      label: line.label,
      value: format(lineValue(line, cursorMs)),
      swatch: line.hidden ? { kind: 'none' } : { kind: 'line', style: line.style },
    });
  }
  for (const pts of [...panel.points].reverse()) {
    out.push({
      id: pts.id,
      label: pts.label,
      value: panel.formatValue(pointValue(pts, cursorMs, pixelMs)),
      swatch: { kind: pts.shape, color: pts.color },
    });
  }
  const ticks = panel.ticks;
  if (ticks) {
    const atCursor = cursorMs !== null;
    const n = atCursor ? valueAt(ticks.t, ticks.v, ticks.stepMs, cursorMs) : finiteSum(ticks.v);
    out.push({
      id: ticks.id,
      label: atCursor ? ticks.label : `${ticks.label} in view`,
      value: formatCount(n),
      swatch: { kind: 'tick', color: ticks.color },
    });
  }
  return out;
}

/** One sentence for screen readers: "Latency at 10:32: TTFT p99 412 ms, TTFT mean 120 ms." */
export function readoutSentence(
  panel: ChartPanel,
  cursorMs: SimMs | null,
  pixelMs: number,
): string {
  const when = cursorMs === null ? 'latest' : `at ${formatClock(cursorMs, true)}`;
  const parts = legendEntries(panel, cursorMs, pixelMs).map((e) => `${e.label} ${e.value}`);
  return `${panel.title} ${when}: ${parts.join(', ')}.`;
}
