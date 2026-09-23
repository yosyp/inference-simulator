// Units and labels for chart axes and readouts: ms and s, %, per second, counts, and simulated
// clock times. Every formatter returns an em dash for a missing value (NaN or ±Infinity).

import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, type SimMs } from '../engine/time.ts';

export const MISSING = '—';

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function trim(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/\.0+$/, '');
}

/** Latency: "4.5 ms", "412 ms", "3.2 s", "32 s", "1.5 min", "12 min". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const a = Math.abs(ms);
  if (a < 10) return `${trim(ms, 1)} ms`;
  if (a < SECOND_MS) return `${Math.round(ms)} ms`;
  if (a < 10 * SECOND_MS) return `${trim(ms / SECOND_MS, 1)} s`;
  if (a < MINUTE_MS) return `${Math.round(ms / SECOND_MS)} s`;
  if (a < 10 * MINUTE_MS) return `${trim(ms / MINUTE_MS, 1)} min`;
  return `${Math.round(ms / MINUTE_MS)} min`;
}

/** A fraction as a percentage: "84%", and one decimal below 10% ("4.8%"). */
export function formatPercent(frac: number): string {
  if (!Number.isFinite(frac)) return MISSING;
  const pct = frac * 100;
  return Math.abs(pct) < 10 && pct !== 0 ? `${trim(pct, 1)}%` : `${Math.round(pct)}%`;
}

/** A rate per second: "0.25/s", "3.2/s", "48/s". */
export function formatRate(perS: number): string {
  if (!Number.isFinite(perS)) return MISSING;
  const a = Math.abs(perS);
  if (a === 0) return '0/s';
  if (a < 1) return `${trim(perS, 2)}/s`;
  if (a < 10) return `${trim(perS, 1)}/s`;
  return `${Math.round(perS).toLocaleString('en-US')}/s`;
}

/** A count or time-weighted level: "3.4", "18", "1,284". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return MISSING;
  if (Math.abs(n) < 10 && !Number.isInteger(n)) return trim(n, 1);
  return Math.round(n).toLocaleString('en-US');
}

/** A ratio such as retry amplification: "1.8×". */
export function formatRatio(r: number): string {
  if (!Number.isFinite(r)) return MISSING;
  return `${r.toFixed(r < 10 ? 1 : 0)}×`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Time of day, "10:30"; with seconds, "10:30:15". */
export function formatClock(ms: SimMs, seconds = false): string {
  if (!Number.isFinite(ms)) return MISSING;
  const tod = ms - Math.floor(ms / DAY_MS) * DAY_MS;
  const h = Math.floor(tod / HOUR_MS);
  const m = Math.floor((tod % HOUR_MS) / MINUTE_MS);
  const hm = `${pad2(h)}:${pad2(m)}`;
  return seconds ? `${hm}:${pad2(Math.floor((tod % MINUTE_MS) / SECOND_MS))}` : hm;
}

/** Short day name of a simulated time: "Mon" … "Fri". */
export function formatDay(ms: SimMs): string {
  const d = Math.floor(ms / DAY_MS);
  return DAY_SHORT[((d % 7) + 7) % 7]!;
}

/** A duration for window labels: "10 h", "1 h 30 min", "15 min", "45 s". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  if (ms < MINUTE_MS) return `${Math.round(ms / SECOND_MS)} s`;
  const totalMin = Math.round(ms / MINUTE_MS);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * Axis tick labels for a latency axis. One unit for the whole axis, chosen by the largest tick
 * (ms below 1 s, else s), with as few decimals as the ticks need. Zero reads "0".
 */
export function msTickFormat(ticks: readonly number[]): (v: number) => string {
  const max = Math.max(0, ...ticks.map(Math.abs));
  const unit = max >= SECOND_MS ? SECOND_MS : 1;
  const suffix = unit === 1 ? ' ms' : ' s';
  const decimals = Math.min(2, Math.max(0, ...ticks.map((t) => decimalsNeeded(t / unit))));
  return (v) => (v === 0 ? '0' : `${(v / unit).toFixed(decimals)}${suffix}`);
}

function decimalsNeeded(x: number): number {
  for (let d = 0; d <= 2; d++) {
    if (Math.abs(Number(x.toFixed(d)) - x) < 1e-9) return d;
  }
  return 2;
}

/** Axis tick labels for a 0..1 axis: "0%", "50%", "100%". */
export function percentTickFormat(): (v: number) => string {
  return (v) => `${Math.round(v * 100)}%`;
}

/** Axis tick labels for counts or rates, with a unit suffix ("/s") when given. */
export function plainTickFormat(suffix = ''): (v: number) => string {
  return (v) => (v === 0 ? '0' : `${formatTickNumber(v)}${suffix}`);
}

function formatTickNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return `${trim(v / 1000, 1)}k`;
  return trim(v, a < 1 ? 2 : a < 10 ? 1 : 0);
}
