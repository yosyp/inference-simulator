// Active-window emission (E9 follow-up, X3). Off-shift night buckets carry nothing: no requests,
// no tokens, every replica Ready. Emitting them cost ~30 MB a week on Server B, so they are skipped.
//
// Rule. A bucket is emitted if it overlaps the day's active window, or if it is not quiet.
// - Active window: [min(first diurnal knot, shift start) − 30 min, shift end + 30 min), clamped to
//   the day. Sessions start only inside the knots cut to the shift, and no next turn is sent after
//   the shift ends (K23), so work outside it is the tail of in-flight requests.
// - Quiet: every scalar is 0 except readyReplicas' fleet series, which equals the replica count
//   (readyReplicas' per-replica series are always 0); a histogram bucket is quiet when empty.
//   A bucket past the tail that still has work (the fleet not yet idle, a replica still down) is
//   not quiet, so it is emitted: the rule is exact, and the window only keeps the edges tidy.
// A chunk's scalar and histogram blocks may therefore start after, and end before, the chunk's
// bucket span (still contiguous inside it). Consumers treat a missing bucket inside a delivered
// chunk's span as quiet (quietScalar; an empty histogram), never as uncomputed.

import { HISTOGRAM_METRICS, type HistogramMetric } from '../histogram.ts';
import type { ScalarMetric } from '../results.ts';
import { DAY_MS, MINUTE_MS, type SimMs } from '../time.ts';

export const ACTIVE_MARGIN_MS = 30 * MINUTE_MS;
export const ACTIVE_TAIL_MS = 30 * MINUTE_MS;

/** The day's active window, absolute ms. dayStartMs is the day's 00:00. */
export function activeWindow(
  dayStartMs: SimMs,
  shift: { startMs: number; endMs: number },
  firstKnotMs: number | undefined,
): { activeFromMs: SimMs; activeToMs: SimMs } {
  const first = Math.min(shift.startMs, firstKnotMs ?? shift.startMs) - ACTIVE_MARGIN_MS;
  const last = shift.endMs + ACTIVE_TAIL_MS;
  const clamp = (t: number) => dayStartMs + Math.min(DAY_MS, Math.max(0, t));
  return { activeFromMs: clamp(first), activeToMs: Math.max(clamp(first), clamp(last)) };
}

/** A quiet bucket's value of `metric` for `series` (0 is the fleet series). */
export function quietScalar(metric: ScalarMetric, series: number, replicas: number): number {
  return metric === 'readyReplicas' && series === 0 ? replicas : 0;
}

/** True if the open scalar bucket ([metric][series], readyReplicas at readyIndex) is quiet. */
export function isQuietScalars(
  open: Float64Array,
  series: number,
  readyIndex: number,
  replicas: number,
): boolean {
  const readyAt = readyIndex * series;
  for (let i = 0; i < open.length; i++) {
    if (open[i] !== (i === readyAt ? replicas : 0)) return false;
  }
  return true;
}

/** True if every open histogram is empty. */
export function isEmptyHists(open: Record<HistogramMetric, Uint32Array>): boolean {
  for (const m of HISTOGRAM_METRICS) {
    const h = open[m];
    for (let i = 0; i < h.length; i++) if (h[i] !== 0) return false;
  }
  return true;
}
