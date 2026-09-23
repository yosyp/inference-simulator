// Short number formats for canvas labels and the text alternative. NaN (missing data) prints "—".

import type { TrackedRequestView } from '../playback/types.ts';

const DASH = '—';

/** Replica label on the canvas: R1 is replica 0, matching "Replica 1" in the status line. */
export function replicaLabel(replica: number): string {
  return `R${replica + 1}`;
}

export function formatPercent(frac: number): string {
  return Number.isFinite(frac) ? `${Math.round(frac * 100)}%` : DASH;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : DASH;
}

/** 850 ms, 1.2 s, 38 s, 2.5 min. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** 850, 1.2k, 12k. */
export function formatCompact(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (a < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** Requests per second: 0.4, 3.2, 12, 140. */
export function formatRate(perS: number): string {
  if (!Number.isFinite(perS)) return DASH;
  if (perS < 10) return perS.toFixed(1);
  return String(Math.round(perS));
}

/** What a tracked turn's label says: its TTFT once known, otherwise its state. */
export function trackedOutcome(req: TrackedRequestView): string {
  switch (req.state) {
    case 'rejected':
      return 'rejected';
    case 'timedOut':
      return 'timed out';
    case 'failed':
      return 'failed';
    default:
      if (req.ttftMs !== null) return formatDuration(req.ttftMs);
      return req.state === 'finished' || req.state === 'decode' ? DASH : req.state;
  }
}
