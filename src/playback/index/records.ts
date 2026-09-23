// Per-request views: individual points for sparse chart buckets (05 §6) and the tracked analyst's
// requests for the canvas (05 §7).

import { OUTCOME, REQUEST_STATE, type RequestBlock } from '../../engine/results.ts';
import { DAY_MS, WEEK_DAYS, type SimMs } from '../../engine/time.ts';
import type { DotState, RequestPoints, TimeWindow, TrackedRequestView } from '../types.ts';
import { recordSources, trackedSources, type DayData } from './day.ts';
import { analystPositions, at, lowerBound, ownerPieces, type Source } from './sources.ts';

const FIRST_TERMINAL: number = REQUEST_STATE.finished;

/** Live request states as canvas dot states. At the router counts as queued. */
export const DOT_STATE: readonly (DotState | undefined)[] = (() => {
  const m: (DotState | undefined)[] = [];
  m[REQUEST_STATE.atRouter] = 'queued';
  m[REQUEST_STATE.waiting] = 'queued';
  m[REQUEST_STATE.prefill] = 'prefill';
  m[REQUEST_STATE.decode] = 'decode';
  m[REQUEST_STATE.preempted] = 'preempted';
  return m;
})();

type OutcomeName = 'finished' | 'rejected' | 'timedOut' | 'failed';
const OUTCOME_NAME: readonly (OutcomeName | undefined)[] = (() => {
  const m: (OutcomeName | undefined)[] = [];
  m[OUTCOME.finished] = 'finished';
  m[OUTCOME.rejected] = 'rejected';
  m[OUTCOME.timedOut] = 'timedOut';
  m[OUTCOME.failed] = 'failed';
  return m;
})();

/**
 * Requests whose endMs falls in the window, keyed by endMs, from scope-'all' records where they
 * exist and tracked-scope records elsewhere. TTFT needs a first token; TPOT and E2E are for
 * finished requests only (NaN otherwise), and TPOT needs at least two output tokens.
 */
export function requestPoints(
  days: readonly (DayData | null)[],
  window: TimeWindow,
): RequestPoints {
  const picks: { rb: RequestBlock; src: Source; lo: number; hi: number }[] = [];
  let total = 0;
  const firstDay = Math.max(0, Math.floor(window.fromMs / DAY_MS));
  const lastDay = Math.min(WEEK_DAYS - 1, Math.floor((window.toMs - 1) / DAY_MS));
  for (let d = firstDay; d <= lastDay; d++) {
    const dd = days[d];
    if (!dd) continue;
    const a = Math.max(window.fromMs, d * DAY_MS);
    const b = Math.min(window.toMs, (d + 1) * DAY_MS);
    for (const piece of ownerPieces(a, b, recordSources(dd, a, b))) {
      const rb = piece.src.chunk.requests;
      const lo = lowerBound(rb.endMs, piece.src.req, piece.fromMs);
      const hi = lowerBound(rb.endMs, piece.src.req, piece.toMs, lo);
      if (hi > lo) {
        picks.push({ rb, src: piece.src, lo, hi });
        total += hi - lo;
      }
    }
  }
  const out: RequestPoints = {
    t: new Float64Array(total),
    ttftMs: new Float64Array(total),
    tpotMs: new Float64Array(total),
    e2eMs: new Float64Array(total),
    replica: new Int8Array(total),
    analyst: new Uint32Array(total),
  };
  let i = 0;
  for (const { rb, src, lo, hi } of picks) {
    for (let p = lo; p < hi; p++, i++) {
      const k = at(src.req, p);
      const arrive = rb.arriveMs[k]!;
      const firstToken = rb.firstTokenMs[k]!;
      const end = rb.endMs[k]!;
      const tokens = rb.outputTokens[k]!;
      const finished = rb.outcome[k] === OUTCOME.finished;
      out.t[i] = end;
      out.ttftMs[i] = firstToken - arrive;
      out.tpotMs[i] = finished && tokens >= 2 ? (end - firstToken) / (tokens - 1) : NaN;
      out.e2eMs[i] = finished ? end - arrive : NaN;
      out.replica[i] = rb.replica[k]!;
      out.analyst[i] = rb.analyst[k]!;
    }
  }
  return out;
}

interface TrackedAcc {
  request: number;
  rec: { rb: RequestBlock; k: number } | null;
  /** First transition seen (arrival), and the first decode transition. */
  firstMs: number;
  firstDecodeMs: number;
  lastMs: number;
  lastState: number;
  lastReplica: number;
}

function accFor(accs: Map<number, TrackedAcc>, request: number): TrackedAcc {
  let a = accs.get(request);
  if (!a) {
    a = {
      request,
      rec: null,
      firstMs: NaN,
      firstDecodeMs: NaN,
      lastMs: -Infinity,
      lastState: -1,
      lastReplica: -1,
    };
    accs.set(request, a);
  }
  return a;
}

function stateOf(a: TrackedAcc, t: SimMs): { state: TrackedRequestView['state']; replica: number } {
  const rec = a.rec;
  if (rec && rec.rb.endMs[rec.k]! <= t) {
    return {
      state: OUTCOME_NAME[rec.rb.outcome[rec.k]!] ?? 'finished',
      replica: rec.rb.replica[rec.k]!,
    };
  }
  if (a.lastState >= 0) {
    const code = a.lastState;
    const state = code >= FIRST_TERMINAL ? OUTCOME_NAME[code] : DOT_STATE[code];
    return {
      state: state ?? 'queued',
      replica: code === REQUEST_STATE.atRouter ? -1 : a.lastReplica,
    };
  }
  // A record without transitions: infer from its timestamps.
  const { rb, k } = rec!;
  if (!(rb.dispatchMs[k]! <= t)) return { state: 'queued', replica: -1 };
  return { state: rb.firstTokenMs[k]! <= t ? 'decode' : 'prefill', replica: rb.replica[k]! };
}

/**
 * The tracked analyst's requests on t's day that have arrived by t, in arrival order, always from
 * tracked-scope data (the trace, then main chunks). State at t comes from the last transition at
 * or before t, or from the record once the request has ended.
 */
export function trackedView(dd: DayData | null, analyst: number, t: SimMs): TrackedRequestView[] {
  if (!dd) return [];
  const dayStart = dd.day * DAY_MS;
  const accs = new Map<number, TrackedAcc>();
  for (const piece of ownerPieces(dayStart, dayStart + DAY_MS, trackedSources(dd))) {
    const src = piece.src;
    const pos = analystPositions(src, analyst);
    const rb = src.chunk.requests;
    for (const p of pos.req) {
      if (p >= src.req.n) break;
      const k = at(src.req, p);
      const end = rb.endMs[k]!;
      if (end < piece.fromMs) continue;
      if (end >= piece.toMs) break;
      if (rb.arriveMs[k]! <= t) accFor(accs, rb.id[k]!).rec = { rb, k };
    }
    const tb = src.chunk.transitions;
    for (const p of pos.tr) {
      if (p >= src.tr.n) break;
      const k = at(src.tr, p);
      const time = tb.atMs[k]!;
      if (time < piece.fromMs) continue;
      if (time >= piece.toMs || time > t) break;
      const a = accFor(accs, tb.request[k]!);
      if (!(a.firstMs <= time)) a.firstMs = time;
      if (tb.state[k] === REQUEST_STATE.decode && Number.isNaN(a.firstDecodeMs)) {
        a.firstDecodeMs = time;
      }
      if (time >= a.lastMs) {
        a.lastMs = time;
        a.lastState = tb.state[k]!;
        a.lastReplica = tb.replica[k]!;
      }
    }
  }

  const views: { arriveMs: number; view: TrackedRequestView }[] = [];
  for (const a of accs.values()) {
    const rec = a.rec;
    const arriveMs = rec ? rec.rb.arriveMs[rec.k]! : a.firstMs;
    const firstTokenMs = rec ? rec.rb.firstTokenMs[rec.k]! : a.firstDecodeMs;
    const { state, replica } = stateOf(a, t);
    const prev = rec ? rec.rb.prevReplica[rec.k]! : -1;
    const served = rec ? rec.rb.replica[rec.k]! : -1;
    views.push({
      arriveMs,
      view: {
        request: a.request,
        turn: rec ? rec.rb.turn[rec.k]! : 0,
        replica: replica >= 0 ? replica : null,
        state,
        ttftMs: firstTokenMs <= t ? firstTokenMs - arriveMs : null,
        moved: prev >= 0 && served >= 0 && served !== prev,
      },
    });
  }
  views.sort((x, y) => x.arriveMs - y.arriveMs || x.view.request - y.view.request);
  return views.map((v) => v.view);
}
