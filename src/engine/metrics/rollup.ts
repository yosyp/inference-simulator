// High-side rollup (01 §8; 02 §11): per replica per day, requests served, mean end-to-end latency,
// and mean nvidia-smi-style utilization, delivered at day N+1 12:00.
//
// Utilization denominator: the analyst shift (config.shift), not the whole day. The High-side
// team reads "how busy was the GPU while people were working"; averaging over 24 hours would
// dilute a saturated shift to about half. busyMs is the replica's step time (E3, t_o included),
// counted where it falls inside [shift start, shift end). A bucket that straddles a shift edge
// contributes pro rata to its overlap; with the usual configs the shift edges are bucket
// boundaries, so this is exact. Busy time outside the shift (a queue draining after it) is not
// counted. requestsServed and meanE2eMs count every request that finished on the replica that day,
// whenever it finished.

import type { DayState } from '../core/types.ts';
import type { RollupRow } from '../results.ts';
import { rollupDeliveryMs } from '../time.ts';

/** The day's rollup rows, one per replica. Call once the day has run to its end. */
export function dayRollup(state: DayState): RollupRow[] {
  const c = state.core;
  if (c.nowMs < c.dayEndMs) {
    throw new Error(`dayRollup: day ${c.day} has run to ${c.nowMs}, not to its end ${c.dayEndMs}`);
  }
  const s = state.metrics;
  const shiftMs = s.shiftEndMs - s.shiftStartMs;
  const rows: RollupRow[] = [];
  for (let r = 0; r < s.replicas; r++) {
    const served = s.served[r]!;
    rows.push({
      day: c.day,
      replica: r,
      requestsServed: served,
      meanE2eMs: served > 0 ? s.servedE2eMs[r]! / served : NaN,
      meanNvidiaSmiUtil: shiftMs > 0 ? s.busyInShiftMs[r]! / shiftMs : 0,
      deliveredAtMs: rollupDeliveryMs(c.day),
    });
  }
  return rows;
}
