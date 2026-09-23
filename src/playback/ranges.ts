// Computed-range arithmetic. Ranges are half-open [fromMs, toMs). "Normalized" means sorted,
// non-empty, and merged where they overlap or touch.

import type { SimMs } from '../engine/time.ts';
import type { ComputedRange } from '../worker/protocol.ts';

export function normalizeRanges(ranges: readonly ComputedRange[]): ComputedRange[] {
  const sorted = ranges.filter((r) => r.toMs > r.fromMs).sort((a, b) => a.fromMs - b.fromMs);
  const out: ComputedRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.fromMs <= last.toMs) {
      if (r.toMs > last.toMs) out[out.length - 1] = { fromMs: last.fromMs, toMs: r.toMs };
    } else {
      out.push({ fromMs: r.fromMs, toMs: r.toMs });
    }
  }
  return out;
}

/** End of the normalized range that contains t, or null when t is not computed. */
export function rangeEndAt(ranges: readonly ComputedRange[], t: SimMs): SimMs | null {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (t < r.fromMs) hi = mid - 1;
    else if (t >= r.toMs) lo = mid + 1;
    else return r.toMs;
  }
  return null;
}

export function isComputedAt(ranges: readonly ComputedRange[], t: SimMs): boolean {
  return rangeEndAt(ranges, t) !== null;
}

/** True when all of [fromMs, toMs) is computed. */
export function coversRange(ranges: readonly ComputedRange[], fromMs: SimMs, toMs: SimMs): boolean {
  const end = rangeEndAt(ranges, fromMs);
  return end !== null && end >= toMs;
}

/** Removes [fromMs, toMs) from normalized ranges. */
export function subtractRange(
  ranges: readonly ComputedRange[],
  fromMs: SimMs,
  toMs: SimMs,
): ComputedRange[] {
  const out: ComputedRange[] = [];
  for (const r of ranges) {
    if (r.toMs <= fromMs || r.fromMs >= toMs) {
      out.push(r);
      continue;
    }
    if (r.fromMs < fromMs) out.push({ fromMs: r.fromMs, toMs: fromMs });
    if (r.toMs > toMs) out.push({ fromMs: toMs, toMs: r.toMs });
  }
  return out;
}

export function sameRanges(a: readonly ComputedRange[], b: readonly ComputedRange[]): boolean {
  return (
    a.length === b.length && a.every((r, i) => r.fromMs === b[i]!.fromMs && r.toMs === b[i]!.toMs)
  );
}
