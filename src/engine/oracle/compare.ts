// Per-request comparison of an engine run with the oracle, and the first diverging event or step.
// Times are compared as offsets (arrival from the day's start; dispatch, first token, end, and
// every state change from arrival) to ≤ 1e-6 relative, or 1e-6 ms absolute near zero. Outcome,
// replica, preemptions, cached tokens, output done, and the sequence of states must be equal.

import { REPLICA_COUNTERS } from '../shared/index.ts';
import type { RunResults, StepRecord } from './types.ts';

export const REL = 1e-6;
export const ABS_MS = 1e-6;

export function close(a: number, b: number, rel = REL, abs = ABS_MS): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

export interface Mismatch {
  /** Request index, or -1 for a replica meter. */
  request: number;
  field: string;
  engine: number | string;
  oracle: number | string;
}

const EXACT = ['outcome', 'replica', 'preemptions', 'cachedTokens', 'outputDone'] as const;

/** Every per-request field that differs. */
export function compareRequests(engine: RunResults, oracle: RunResults): Mismatch[] {
  const a = engine.requests;
  const b = oracle.requests;
  const out: Mismatch[] = [];
  for (let i = 0; i < a.outcome.length; i++) {
    const push = (field: string, x: number | string, y: number | string) =>
      out.push({ request: i, field, engine: x, oracle: y });
    for (const f of EXACT) if (a[f][i] !== b[f][i]) push(f, a[f][i]!, b[f][i]!);
    const arrive = [a.arriveMs[i]! - engine.dayStartMs, b.arriveMs[i]! - oracle.dayStartMs];
    if (!close(arrive[0]!, arrive[1]!)) push('arrival', arrive[0]!, arrive[1]!);
    for (const f of ['dispatchMs', 'firstTokenMs', 'endMs'] as const) {
      const x = a[f][i]! - a.arriveMs[i]!;
      const y = b[f][i]! - b.arriveMs[i]!;
      if (!close(x, y)) push(`${f} - arrival`, x, y);
    }
    const ta = a.transitions[i]!;
    const tb = b.transitions[i]!;
    const states = (t: number[]) => t.filter((_, k) => k % 2 === 1).join(',');
    if (states(ta) !== states(tb)) push('states', states(ta), states(tb));
    else {
      for (let k = 0; k < ta.length; k += 2) {
        const x = ta[k]! - a.arriveMs[i]!;
        const y = tb[k]! - b.arriveMs[i]!;
        if (!close(x, y)) push(`state ${ta[k + 1]} at - arrival`, x, y);
      }
    }
  }
  return out;
}

/** Replica meters (cumulative at the end of the day) that differ. */
export function compareCounters(engine: RunResults, oracle: RunResults): Mismatch[] {
  const out: Mismatch[] = [];
  for (const c of REPLICA_COUNTERS) {
    engine.counters[c].forEach((x, r) => {
      const y = oracle.counters[c][r]!;
      if (!close(x, y, REL, 1e-6))
        out.push({ request: -1, field: `${c}[${r}]`, engine: x, oracle: y });
    });
  }
  return out;
}

/** Final KV pool contents that differ (a same-step ordering difference shows up here first). */
export function comparePools(engine: RunResults, oracle: RunResults): Mismatch[] {
  const out: Mismatch[] = [];
  engine.pools.forEach((a, r) => {
    const b = oracle.pools[r]!;
    const push = (field: string, x: number | string, y: number | string) =>
      out.push({ request: -1, field: `kv[${r}] ${field}`, engine: x, oracle: y });
    for (const f of ['free', 'referenced', 'evictions'] as const)
      if (a[f] !== b[f]) push(f, a[f], b[f]);
    const k = a.lruKeys.findIndex((key, j) => key !== b.lruKeys[j]);
    if (k >= 0 || a.lruKeys.length !== b.lruKeys.length) {
      const at = k >= 0 ? k : Math.min(a.lruKeys.length, b.lruKeys.length);
      push(
        `LRU key ${at} of ${a.lruKeys.length} / ${b.lruKeys.length}`,
        a.lruKeys[at] ?? '-',
        b.lruKeys[at] ?? '-',
      );
    }
  });
  return out;
}

/** One thing that happened to a request: ms from the day's start, and what. */
export type RequestEvent = [atMs: number, what: string];

/** A request's events: arrival, dispatch (with its replica), then every state change. */
export function requestEvents(run: RunResults, i: number, name: (code: number) => string) {
  const r = run.requests;
  const out: RequestEvent[] = [];
  if (!Number.isNaN(r.arriveMs[i]!)) out.push([r.arriveMs[i]! - run.dayStartMs, 'arrived']);
  if (!Number.isNaN(r.dispatchMs[i]!)) {
    out.push([r.dispatchMs[i]! - run.dayStartMs, `dispatched to replica ${r.replica[i]}`]);
  }
  const t = r.transitions[i]!;
  for (let k = 0; k < t.length; k += 2) out.push([t[k]! - run.dayStartMs, name(t[k + 1]!)]);
  return out;
}

export interface EventDivergence {
  request: number;
  /** Time of the first differing event, ms from the day's start. */
  atMs: number;
  index: number;
  engine: RequestEvent | null;
  oracle: RequestEvent | null;
}

/**
 * The earliest request event that differs. An event differs if what happened or when (from the
 * day's start, to 1e-9 relative) differs, or one side lacks it.
 */
export function firstDivergentEvent(
  engine: RunResults,
  oracle: RunResults,
  name: (code: number) => string,
): EventDivergence | null {
  let best: EventDivergence | null = null;
  for (let i = 0; i < engine.requests.outcome.length; i++) {
    const ea = requestEvents(engine, i, name);
    const eb = requestEvents(oracle, i, name);
    for (let k = 0; k < Math.max(ea.length, eb.length); k++) {
      const x = ea[k] ?? null;
      const y = eb[k] ?? null;
      if (x && y && x[1] === y[1] && close(x[0], y[0], 1e-9)) continue;
      const atMs = Math.min(x ? x[0] : Infinity, y ? y[0] : Infinity);
      if (best === null || atMs < best.atMs)
        best = { request: i, atMs, index: k, engine: x, oracle: y };
      break;
    }
  }
  return best;
}

function sameStep(x: StepRecord, y: StepRecord): boolean {
  return (
    x.clock === y.clock &&
    close(x.atMs, y.atMs, 1e-9) &&
    x.decodeSeqs === y.decodeSeqs &&
    x.decodeContextTokens === y.decodeContextTokens &&
    x.preempted === y.preempted &&
    x.chunks.join(',') === y.chunks.join(',')
  );
}

export interface StepDivergence {
  replica: number;
  /** Index into each side's steps on that replica. */
  index: number;
  engine: StepRecord[];
  oracle: StepRecord[];
}

/** The earliest step that differs between two per-step traces, with each replica's steps. */
export function firstDivergentStep(
  engine: StepRecord[],
  oracle: StepRecord[],
): StepDivergence | null {
  let best: StepDivergence | null = null;
  let bestAt = Infinity;
  const replicas = Math.max(
    0,
    ...engine.map((s) => s.replica + 1),
    ...oracle.map((s) => s.replica + 1),
  );
  for (let r = 0; r < replicas; r++) {
    const a = engine.filter((s) => s.replica === r);
    const b = oracle.filter((s) => s.replica === r);
    for (let k = 0; k < Math.max(a.length, b.length); k++) {
      const x = a[k];
      const y = b[k];
      if (x && y && sameStep(x, y)) continue;
      const at = Math.min(x?.atMs ?? Infinity, y?.atMs ?? Infinity);
      if (at < bestAt) {
        bestAt = at;
        best = { replica: r, index: k, engine: a, oracle: b };
      }
      break;
    }
  }
  return best;
}

export function formatStep(s: StepRecord | undefined, dayStartMs: number): string {
  if (!s) return '(none)';
  const chunks: string[] = [];
  for (let k = 0; k < s.chunks.length; k += 3) {
    chunks.push(`#${s.chunks[k]} ${s.chunks[k + 1]}+${s.chunks[k + 2]}`);
  }
  const span = s.steps > 1 ? ` span of ${s.steps}` : '';
  return (
    `clock ${s.clock} at ${(s.atMs - dayStartMs).toFixed(6)} ms (${s.durationMs.toFixed(6)} ms${span}): ` +
    `${s.decodeSeqs} decodes (context ${s.decodeContextTokens}), ` +
    `chunks [${chunks.join('; ')}]${s.preempted ? ', preempted' : ''}`
  );
}
