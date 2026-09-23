// Test support for the results index: a deterministic world of individual requests with scope-'all'
// records and transitions, chunked like the worker would, and a brute-force reference for the
// canvas dots. Imported only by tests.

import {
  OUTCOME,
  REQUEST_STATE,
  allocRequestBlock,
  allocTransitionBlock,
  type ResultChunk,
} from '../../engine/results.ts';
import type { SimMs } from '../../engine/time.ts';
import { makeFixtureChunk } from '../../fixtures/chunks.ts';
import { hash01 } from '../../fixtures/synthetic.ts';

export interface WorldTransition {
  atMs: number;
  state: number;
  replica: number;
}

export interface WorldRequest {
  id: number;
  analyst: number;
  session: number;
  turn: number;
  replica: number;
  prevReplica: number;
  arriveMs: number;
  dispatchMs: number;
  firstTokenMs: number;
  endMs: number;
  outputTokens: number;
  outcome: number;
  transitions: WorldTransition[];
}

export interface WorldOptions {
  fromMs: SimMs;
  toMs: SimMs;
  replicas: number;
  perSecond: number;
  /** Emit finished/timedOut/failed transitions at the end, or leave the end to the record. */
  terminalTransitions: boolean;
  seed?: number;
}

const S = REQUEST_STATE;

/** Requests arriving over [fromMs, toMs); many wait, prefill, or decode across chunk boundaries. */
export function makeWorld(o: WorldOptions): WorldRequest[] {
  const out: WorldRequest[] = [];
  const seed = o.seed ?? 1;
  const n = Math.floor(((o.toMs - o.fromMs) / 1000) * o.perSecond);
  for (let i = 0; i < n; i++) {
    const h = (salt: number) => hash01(i, seed, salt);
    const id = 1000 + i;
    const arrive = o.fromMs + Math.floor((i / o.perSecond) * 1000 + h(1) * 500);
    const replica = Math.floor(h(2) * o.replicas);
    const analyst = Math.floor(h(3) * 40);
    const tr: WorldTransition[] = [{ atMs: arrive, state: S.atRouter, replica: -1 }];
    const kind = h(4);
    const req: WorldRequest = {
      id,
      analyst,
      session: Math.floor(id / 3),
      turn: (id % 3) + 1,
      replica,
      prevReplica: id % 3 === 0 ? -1 : Math.floor(h(5) * o.replicas),
      arriveMs: arrive,
      dispatchMs: NaN,
      firstTokenMs: NaN,
      endMs: NaN,
      outputTokens: 0,
      outcome: OUTCOME.finished,
      transitions: tr,
    };
    out.push(req);
    if (kind < 0.05) {
      req.replica = -1;
      req.outcome = OUTCOME.rejected;
      req.endMs = arrive + 1;
      tr.push({ atMs: arrive + 1, state: S.rejected, replica: -1 });
      continue;
    }
    const dispatch = arrive + 2 + Math.floor(h(6) * 3);
    req.dispatchMs = dispatch;
    tr.push({ atMs: dispatch, state: S.waiting, replica });
    let t = dispatch + Math.floor(h(7) * h(7) * 40_000);
    if (kind < 0.09) {
      req.outcome = OUTCOME.timedOut;
      req.endMs = t + 1;
      if (o.terminalTransitions) tr.push({ atMs: t + 1, state: S.timedOut, replica });
      continue;
    }
    tr.push({ atMs: t, state: S.prefill, replica });
    if (kind > 0.9) {
      // Preempted once, then waits and recomputes.
      t += 50 + Math.floor(h(8) * 5_000);
      tr.push({ atMs: t, state: S.preempted, replica });
      t += 100 + Math.floor(h(9) * 20_000);
      tr.push({ atMs: t, state: S.prefill, replica });
    }
    t += 20 + Math.floor(h(10) * h(10) * 15_000);
    req.firstTokenMs = t;
    tr.push({ atMs: t, state: S.decode, replica });
    req.outputTokens = 1 + Math.floor(h(11) * 600);
    t += 5 + req.outputTokens * (15 + Math.floor(h(12) * 25));
    req.endMs = t;
    if (kind < 0.12) {
      req.outcome = OUTCOME.failed;
      if (o.terminalTransitions) tr.push({ atMs: t, state: S.failed, replica });
    } else if (o.terminalTransitions) {
      tr.push({ atMs: t, state: S.finished, replica });
    }
  }
  return out;
}

/**
 * A chunk for [fromMs, toMs) (multiples of a minute, within one day): fixture scalars and
 * histograms, plus scope-'all' records and transitions in [historyFromMs, toMs). historyFromMs
 * defaults to fromMs; a detail window passes an earlier time so requests in flight at its start
 * come with their history (and requests that ended during it, with their records).
 */
export function worldChunk(
  world: readonly WorldRequest[],
  replicas: number,
  fromMs: SimMs,
  toMs: SimMs,
  historyFromMs: SimMs = fromMs,
): ResultChunk {
  const chunk = makeFixtureChunk({ replicas }, fromMs, toMs);
  const recs = world.filter((r) => r.endMs >= historyFromMs && r.endMs < toMs);
  const trs: { r: WorldRequest; x: WorldTransition }[] = [];
  for (const r of world) {
    for (const x of r.transitions) if (x.atMs >= historyFromMs && x.atMs < toMs) trs.push({ r, x });
  }
  trs.sort((a, b) => a.x.atMs - b.x.atMs);
  recs.sort((a, b) => a.endMs - b.endMs);
  const requests = allocRequestBlock('all', recs.length);
  recs.forEach((r, k) => {
    requests.id[k] = r.id;
    requests.session[k] = r.session;
    requests.analyst[k] = r.analyst;
    requests.turn[k] = r.turn;
    requests.replica[k] = r.replica;
    requests.prevReplica[k] = r.prevReplica;
    requests.arriveMs[k] = r.arriveMs;
    requests.dispatchMs[k] = r.dispatchMs;
    requests.firstTokenMs[k] = r.firstTokenMs;
    requests.endMs[k] = r.endMs;
    requests.outputTokens[k] = r.outputTokens;
    requests.outcome[k] = r.outcome;
  });
  const transitions = allocTransitionBlock('all', trs.length);
  trs.forEach(({ r, x }, k) => {
    transitions.atMs[k] = x.atMs;
    transitions.request[k] = r.id;
    transitions.analyst[k] = r.analyst;
    transitions.replica[k] = x.replica;
    transitions.state[k] = x.state;
  });
  return { ...chunk, requests, transitions };
}

export interface RefDot {
  request: number;
  state: number;
  replica: number;
  progress: number;
}

/**
 * Brute force: each request's state at t is its last transition at or before t, ended by a terminal
 * state or by its record's endMs. Only data before horizonMs exists (the cut or the data's end).
 */
export function referenceDots(
  world: readonly WorldRequest[],
  t: SimMs,
  horizonMs: SimMs = Infinity,
): RefDot[] {
  const out: RefDot[] = [];
  for (const r of world) {
    const known = r.transitions.filter((x) => x.atMs < horizonMs);
    let last = -1;
    for (let i = 0; i < known.length; i++) if (known[i]!.atMs <= t) last = i;
    if (last < 0) continue;
    const cur = known[last]!;
    if (cur.state >= REQUEST_STATE.finished) continue;
    const endKnown = r.endMs < horizonMs ? r.endMs : Infinity;
    if (endKnown <= t) continue;
    const next = last + 1 < known.length ? known[last + 1]!.atMs : endKnown;
    const progress =
      next < Infinity && next > cur.atMs
        ? Math.min(1, Math.max(0, (t - cur.atMs) / (next - cur.atMs)))
        : 0;
    out.push({ request: r.id, state: cur.state, replica: cur.replica, progress });
  }
  return out.sort((a, b) => a.request - b.request);
}
