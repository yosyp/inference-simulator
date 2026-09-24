// The oracle's day: a plain loop over a time-ordered agenda that drives the scripted client, a
// router built from E7's pure helpers, and one oracle scheduler per replica (scheduler.ts), which
// ticks every engine step. Same-instant order follows K27's bands: infra (replica state), engine
// (step ends), client (timeouts, cancels), router (dispatch, then signal refresh), arrivals, and
// last the kick that composes an idle replica's first step. Ties within a band go in the order the
// events were scheduled.
//
// Client (the engine run's driver does the same): a request arrives at its scripted time, or its
// delay after the request it follows ends (any outcome). Its timeout to first token is armed at
// arrival and disarmed by the first token or the end; a scripted cancel fires if it is still in
// flight. Router (E7, 02 §7, K9): reject when nothing is routable or the admitted-not-ended count
// is at the cap; otherwise choose with chooseReplica on the last signal snapshot and dispatch after
// routerOverheadMs, choosing again if that replica stopped being routable. A snapshot copies the
// outstanding counts and each pool's referenced fraction every signalRefreshMs (before every
// choice when that is 0 or less). Crashed replicas stay routable until they are marked down.

import type { SimConfig } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { PRIORITY } from '../core/index.ts';
import { createMorningKvPool, kvUsedFrac } from '../kv/index.ts';
import { OUTCOME, REPLICA_STATE } from '../results.ts';
import { Source, u01 } from '../rng/index.ts';
import {
  buildRing,
  chooseReplica,
  policyCanTie,
  policyUsesHash,
  rebuildRoutableList,
  sessionHash,
  type RoutingView,
} from '../router/index.ts';
import { REQUEST_KIND } from '../shared/index.ts';
import { DAY_MS, dayStartMs } from '../time.ts';
import {
  PHASE,
  cancel,
  compose,
  createReplica,
  endStep,
  eligible,
  enqueue,
  setState,
  type EngineLimits,
  type Host,
  type OReq,
} from './scheduler.ts';
import {
  emptyCounters,
  emptyRequestResults,
  poolContents,
  type OracleInput,
  type RunResults,
} from './types.ts';

const K = {
  replicaChange: 1,
  stepEnd: 2,
  timeout: 3,
  cancelAt: 4,
  dispatch: 5,
  refresh: 6,
  arrive: 7,
  kick: 8,
  eligible: 9,
} as const;

interface Item {
  t: number;
  prio: number;
  seq: number;
  kind: number;
  a: number;
  b: number;
}

/** Whether x comes before y: (time, priority band, scheduling order). */
function before(x: Item, y: Item): boolean {
  if (x.t !== y.t) return x.t < y.t;
  if (x.prio !== y.prio) return x.prio < y.prio;
  return x.seq < y.seq;
}

/** calibration.engine with config.engineOverrides applied. */
export function engineLimitsOf(config: SimConfig, cal: Calibration): EngineLimits {
  const e = cal.engine;
  const o = config.engineOverrides;
  return {
    kvPoolTokens: e.kvPoolTokens,
    blockSize: e.blockSize,
    maxNumSeqs: o.maxNumSeqs ?? e.maxNumSeqs,
    maxNumBatchedTokens: o.maxNumBatchedTokens ?? e.maxNumBatchedTokens,
    maxModelLen: e.maxModelLen,
  };
}

export interface OracleOptions {
  /** Record every composed step (for finding the first diverging step). */
  trace?: boolean;
}

/** Runs the input's day to the end of its last request. */
export function runOracle(input: OracleInput, options: OracleOptions = {}): RunResults {
  const { cal, config, day, requests: specs } = input;
  const params = config.tunable;
  const limits = engineLimitsOf(config, cal);
  const dayStart = dayStartMs(day);
  const dayEnd = dayStart + DAY_MS;
  const res = emptyRequestResults(specs.length);
  const counters = emptyCounters(config.replicas);
  const trace = options.trace ? [] : null;

  // ----- The agenda: a list kept in descending order, so the next item is the last -----
  const agenda: Item[] = [];
  const dead = new Set<number>();
  let seq = 0;
  let now = dayStart;
  function schedule(t: number, prio: number, kind: number, a = 0, b = 0): number {
    if (t < now) throw new Error(`oracle: scheduled at ${t}, before now ${now}`);
    if (t >= dayEnd) return -1;
    const item: Item = { t, prio, seq: seq++, kind, a, b };
    let lo = 0;
    let hi = agenda.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (before(agenda[mid]!, item)) hi = mid;
      else lo = mid + 1;
    }
    agenda.splice(lo, 0, item);
    return item.seq;
  }
  const unschedule = (handle: number) => {
    if (handle >= 0) dead.add(handle);
  };

  // ----- Requests, replicas, and the router's view -----
  const reqs: OReq[] = specs.map((s, i) => ({
    ...{ i, session: s.session, turn: s.turn, promptTokens: s.promptTokens },
    ...{ outputTarget: s.outputTokens, systemPromptTokens: s.systemPromptTokens },
    ...{ phase: PHASE.none, blocks: [], registered: 0, computed: 0, target: 0, generated: 0 },
    ...{ hitTokens: 0, highWater: 0, firstTokenMs: NaN, cachedTokens: 0, preemptions: 0 },
    eligibleHandle: -1,
  }));
  const followers: number[][] = specs.map(() => []);
  const timeoutEv = new Array<number>(specs.length).fill(-1);
  let open = specs.length;
  const replicas = Array.from({ length: config.replicas }, (_, r) =>
    createReplica(r, createMorningKvPool(limits, params.systemPromptTokens)),
  );
  const view: RoutingView = {
    routable: new Uint8Array(config.replicas).fill(1),
    routableList: new Int32Array(config.replicas),
    routableCount: 0,
    ring: buildRing(config.seed, config.replicas, config.virtualNodesPerReplica),
    seenOutstanding: new Float64Array(config.replicas),
    seenKv: new Float64Array(config.replicas),
    rrLast: -1,
  };
  rebuildRoutableList(view);
  const outstanding = new Array<number>(config.replicas).fill(0);
  /** Admitted and waiting out the router overhead: request → dispatch handle. */
  const pending = new Map<number, number>();
  /** Dispatched and not ended: request → replica. */
  const dispatched = new Map<number, number>();

  function ended(req: OReq, outcome: number, t: number, outputDone: number): void {
    const i = req.i;
    res.endMs[i] = t;
    res.outcome[i] = outcome;
    res.outputDone[i] = outputDone;
    res.cachedTokens[i] = req.cachedTokens;
    res.preemptions[i] = req.preemptions;
    res.transitions[i]!.push(t, outcome);
    unschedule(timeoutEv[i]!);
    const r = dispatched.get(i);
    if (r !== undefined) {
      dispatched.delete(i);
      outstanding[r]!--;
    }
    open--;
    for (const f of followers[i]!) schedule(t + specs[f]!.atMs, PRIORITY.arrival, K.arrive, f);
  }

  const host: Host = {
    cal,
    limits,
    counters,
    trace,
    scheduleStep: (r, t, kick) =>
      kick ? schedule(t, PRIORITY.late, K.kick, r) : schedule(t, PRIORITY.engine, K.stepEnd, r),
    cancelStep: unschedule,
    scheduleEligible: (req, t) => schedule(t, PRIORITY.router, K.eligible, req.i),
    transition: (req, state, t) => res.transitions[req.i]!.push(t, state),
    firstToken(req, t) {
      res.firstTokenMs[req.i] = t;
      unschedule(timeoutEv[req.i]!);
      timeoutEv[req.i] = -1;
    },
    ended,
  };

  function refreshSignals(): void {
    for (let r = 0; r < replicas.length; r++) {
      view.seenOutstanding[r] = outstanding[r]!;
      view.seenKv[r] = kvUsedFrac(replicas[r]!.pool);
    }
  }

  function choose(i: number): number {
    if (params.signalRefreshMs <= 0) refreshSignals();
    const s = specs[i]!;
    const hash = policyUsesHash(params) ? sessionHash(config.seed, day, s.session) : 0;
    const tieU = policyCanTie(params)
      ? u01(config.seed, Source.routingTieBreak, day, s.session, s.turn, 0, REQUEST_KIND.turn)
      : 0;
    const r = chooseReplica(view, params, hash, tieU);
    if (params.routingPolicy === 'roundRobin' && r >= 0) view.rrLast = r;
    return r;
  }

  function arrive(i: number): void {
    res.arriveMs[i] = now;
    const s = specs[i]!;
    if (s.timeoutMs !== undefined) {
      timeoutEv[i] = schedule(now + s.timeoutMs, PRIORITY.client, K.timeout, i);
    }
    const limit = params.admissionLimitPerReplica;
    const cap = limit === null ? Infinity : limit * view.routableCount;
    if (view.routableCount === 0 || pending.size + dispatched.size >= cap) {
      ended(reqs[i]!, OUTCOME.rejected, now, 0);
      return;
    }
    const r = choose(i);
    pending.set(i, schedule(now + config.routerOverheadMs, PRIORITY.router, K.dispatch, i, r));
  }

  function dispatch(i: number, chosen: number): void {
    pending.delete(i);
    let r = chosen;
    if (view.routable[r] !== 1) {
      r = choose(i);
      if (r < 0) {
        ended(reqs[i]!, OUTCOME.rejected, now, 0);
        return;
      }
    }
    res.dispatchMs[i] = now;
    res.replica[i] = r;
    outstanding[r]!++;
    dispatched.set(i, r);
    enqueue(host, replicas[r]!, reqs[i]!, now);
  }

  function cancelRequest(i: number): void {
    const req = reqs[i]!;
    const h = pending.get(i);
    if (h !== undefined) {
      unschedule(h);
      pending.delete(i);
      ended(req, OUTCOME.timedOut, now, 0);
    } else if (req.phase !== PHASE.none) {
      cancel(host, replicas[res.replica[i]!]!, req, now);
    }
  }

  function changeReplica(r: number, code: number): void {
    let routable = view.routable[r]!;
    if (code === REPLICA_STATE.ready) routable = 1;
    else if (code !== REPLICA_STATE.crashed) routable = 0; // down or loading
    if (routable !== view.routable[r]) {
      view.routable[r] = routable;
      rebuildRoutableList(view);
    }
    setState(host, replicas[r]!, code, now);
  }

  // ----- The day's opening agenda, then the loop -----
  specs.forEach((s, i) => {
    if (s.after === undefined) schedule(dayStart + s.atMs, PRIORITY.arrival, K.arrive, i);
    else followers[s.after]!.push(i);
    if (s.cancelAtMs !== undefined) {
      schedule(dayStart + s.cancelAtMs, PRIORITY.client, K.cancelAt, i);
    }
  });
  input.replicaChanges.forEach((c, k) =>
    schedule(dayStart + c.atMs, PRIORITY.infra, K.replicaChange, k),
  );
  if (params.signalRefreshMs > 0) {
    schedule(dayStart + params.signalRefreshMs, PRIORITY.router + 1, K.refresh);
  }

  // Until every request has ended, every step in flight (even one whose requests all left) is
  // over, and every replica change has happened, so the meters and pools are final.
  let changesLeft = input.replicaChanges.length;
  while (open > 0 || changesLeft > 0 || replicas.some((rep) => rep.mode !== 'idle')) {
    const item = agenda.pop();
    if (item === undefined) break;
    if (dead.delete(item.seq)) continue;
    now = item.t;
    const i = item.a;
    switch (item.kind) {
      case K.replicaChange: {
        changesLeft--;
        const c = input.replicaChanges[i]!;
        changeReplica(c.replica, c.state);
        break;
      }
      case K.stepEnd:
        if (replicas[i]!.mode !== 'step') throw new Error(`oracle: stale step end on replica ${i}`);
        replicas[i]!.handle = -1;
        endStep(host, replicas[i]!, now);
        break;
      case K.timeout:
        timeoutEv[i] = -1;
        if (Number.isNaN(res.endMs[i]!) && Number.isNaN(res.firstTokenMs[i]!)) cancelRequest(i);
        break;
      case K.cancelAt:
        if (!Number.isNaN(res.arriveMs[i]!) && Number.isNaN(res.endMs[i]!)) cancelRequest(i);
        break;
      case K.dispatch:
        dispatch(i, item.b);
        break;
      case K.refresh:
        refreshSignals();
        schedule(now + params.signalRefreshMs, PRIORITY.router + 1, K.refresh);
        break;
      case K.arrive:
        arrive(i);
        break;
      case K.eligible:
        eligible(host, replicas[res.replica[i]!]!, reqs[i]!, now);
        break;
      case K.kick:
        if (replicas[i]!.mode !== 'kick') throw new Error(`oracle: stale kick on replica ${i}`);
        replicas[i]!.handle = -1;
        compose(host, replicas[i]!, now);
        break;
    }
  }
  return {
    dayStartMs: dayStart,
    requests: res,
    counters,
    pools: replicas.map((rep) => poolContents(rep.pool)),
    steps: trace ?? [],
  };
}
