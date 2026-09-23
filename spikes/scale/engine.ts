// S1 spike: a deliberately simplified single-day Server B engine. Throwaway code.
//
// - Ticks every engine step (no event-jumping); counts decode-only runs to estimate what jumping saves.
// - Paged KV with a doubly-linked free queue per replica (vLLM V1 style). By default no content
//   hashing: only the shared system prompt's full blocks are cached (pinned). With
//   opts.prefixCache, history blocks are identified by (session, block index) and kept evictable,
//   with LRU eviction from the free queue's head (02 §7 rule 5), to measure what that costs:
//   prefixImpl 'map' uses a Map per block like a hash table; 'owner' uses per-block owner arrays
//   and a per-session chain of cached blocks (the layout the report recommends for E4).
// - Scheduler: running requests in admission order (decodes, then any partial prefill chunk),
//   then waiting requests FCFS within max_num_batched_tokens and max_num_seqs; blocks allocated per
//   scheduled chunk; recompute preemption of the most recently admitted running request.
// - Round-robin routing with zero router overhead; timeout to first token aborts and abandons
//   the session (no retries).
// - Roofline step time from the calibration (02 §6).
// State is plain data (objects, arrays, typed arrays, Maps) so structuredClone can checkpoint it.

import type { Calibration } from '../../src/engine/calibration.ts';
import { REQUEST_STATE, type ResultChunk } from '../../src/engine/results.ts';
import { DAY_MS } from '../../src/engine/time.ts';
import {
  emitChunk,
  flushHistBucket,
  flushScalarBucket,
  M,
  makeRecorder,
  MI,
  pushRequest,
  pushTransition,
  recordFinish,
  recordTtft,
  type Recorder,
} from './recorder.ts';
import {
  planSessions,
  sessionTurns,
  turnMessageTokens,
  turnOutputTokens,
  turnThinkMs,
  type SessionPlan,
  type SpikeConfig,
} from './workload.ts';

export interface EngineOptions {
  /** Which request records and transitions to write. 'none' skips them entirely. */
  detail: 'all' | 'tracked' | 'none';
  trackedAnalyst: number;
  prefixCache: boolean;
  /** Prefix keys as small integers (default) or as doubles, to show the Map cost difference. */
  prefixSmiKeys?: boolean;
  /**
   * 'map': a Map from (session, block index) to block, like a content-hash table.
   * 'owner': per-block owner arrays plus a per-session list of cached blocks; no Map per block.
   */
  prefixImpl?: 'map' | 'owner';
  /** Scalar and histogram buckets. */
  recordMetrics: boolean;
}

export interface Req {
  id: number;
  session: number;
  analyst: number;
  turn: number;
  replica: number;
  prevReplica: number;
  promptTokens: number;
  outputTarget: number;
  numTokens: number;
  computed: number;
  generated: number;
  cachedTokens: number;
  blocks: number[];
  hashed: number;
  sched: number;
  arriveMs: number;
  dispatchMs: number;
  firstTokenMs: number;
  endMs: number;
  preemptions: number;
  recomputeLeft: number;
  state: number;
  aborted: boolean;
  done: boolean;
  record: boolean;
}

export interface Session {
  id: number;
  analyst: number;
  turns: number;
  history: number;
  nextTurn: number;
  inflight: Req | null;
  pendingTurn: number;
  abandoned: boolean;
  lastReplica: number;
  /** 'owner' prefix mode: first cached history block per replica, or -1. */
  cacheHead: Int32Array | null;
}

export interface Replica {
  id: number;
  nBlocks: number;
  ref: Uint16Array;
  key: Float64Array;
  prev: Int32Array;
  next: Int32Array;
  head: number;
  tail: number;
  numFree: number;
  keyMap: Map<number, number>;
  /** 'owner' prefix mode only (else length 0): the session and block index a full block holds. */
  owner: Int32Array;
  ownerIdx: Uint16Array;
  /** 'owner' mode: the next block in the same session's cached sequence, or -1. */
  nextInSeq: Int32Array;
  running: Req[];
  waiting: Req[];
  stepReqs: Req[];
  stepEndMs: number;
  stepMs: number;
  stepPrefill: number;
  stepDecode: number;
  stepRecompute: number;
  flopsRate: number;
  busy: number;
  lastT: number;
  prevDecodeOnly: boolean;
  dirty: boolean;
}

export interface Counters {
  sessions: number;
  arrivals: number;
  admits: number;
  firstTokens: number;
  finishes: number;
  timeouts: number;
  abandoned: number;
  preemptions: number;
  evictions: number;
  steps: number;
  prefillSteps: number;
  decodeOnlySteps: number;
  /** Steps that start a new decode-only-or-other segment: what an event-jumping engine would process. */
  segments: number;
  heapEvents: number;
  prefillTokens: number;
  decodeTokens: number;
  recomputedTokens: number;
  prefixQueryTokens: number;
  prefixHitTokens: number;
  /** Sum over steps of scheduled requests: the per-request work a ticking engine does. */
  reqSteps: number;
}

interface HeapEv {
  t: number;
  seq: number;
  session: number;
  turn: number;
}

export interface DayState {
  day: number;
  dayStartMs: number;
  nowMs: number;
  seq: number;
  nextReqId: number;
  rr: number;
  nextSession: number;
  sessions: Map<number, Session>;
  heap: HeapEv[];
  /** Timeouts are FIFO in arrival order: [deadline, req]. */
  tq: Req[];
  tqHead: number;
  replicas: Replica[];
  counters: Counters;
  rec: Recorder;
  nextBucketMs: number;
  nextHistMs: number;
  kvLevels: Float64Array;
}

export interface DayRun {
  state: DayState;
  plan: SessionPlan;
  advance(untilMs: number): ResultChunk;
  /** Engine state without the recorder's emitted-output buffers; call right after advance(). */
  checkpointState(): DayState;
}

function newCounters(): Counters {
  return {
    sessions: 0, arrivals: 0, admits: 0, firstTokens: 0, finishes: 0, timeouts: 0, abandoned: 0,
    preemptions: 0, evictions: 0, steps: 0, prefillSteps: 0, decodeOnlySteps: 0, segments: 0,
    heapEvents: 0, prefillTokens: 0, decodeTokens: 0, recomputedTokens: 0, prefixQueryTokens: 0,
    prefixHitTokens: 0, reqSteps: 0,
  };
}

function makeReplica(id: number, nBlocks: number, sysBlocks: number, t0: number, mode: 'none' | 'map' | 'owner'): Replica {
  const prev = new Int32Array(nBlocks);
  const next = new Int32Array(nBlocks);
  const ref = new Uint16Array(nBlocks);
  const key = new Float64Array(mode === 'map' ? nBlocks : 0).fill(-1);
  const ob = mode === 'owner' ? nBlocks : 0;
  // Blocks [0, sysBlocks) hold the shared system prompt and stay referenced (standard morning state).
  for (let b = 0; b < sysBlocks; b++) ref[b] = 1;
  let head = -1;
  let tail = -1;
  for (let b = sysBlocks; b < nBlocks; b++) {
    prev[b] = tail;
    next[b] = -1;
    if (tail >= 0) next[tail] = b;
    else head = b;
    tail = b;
  }
  return {
    id, nBlocks, ref, key, prev, next, head, tail, numFree: nBlocks - sysBlocks, keyMap: new Map(),
    owner: new Int32Array(ob).fill(-1), ownerIdx: new Uint16Array(ob), nextInSeq: new Int32Array(ob).fill(-1),
    running: [], waiting: [], stepReqs: [], stepEndMs: Infinity, stepMs: 0, stepPrefill: 0,
    stepDecode: 0, stepRecompute: 0, flopsRate: 0, busy: 0, lastT: t0, prevDecodeOnly: false, dirty: true,
  };
}

export function createDay(
  cfg: SpikeConfig,
  cal: Calibration,
  day: number,
  opts: EngineOptions,
  restore?: DayState,
): DayRun {
  const dayStartMs = day * DAY_MS;
  const plan = planSessions(cfg, day, dayStartMs);
  const BS = cal.engine.blockSize;
  const nBlocks = cal.engine.kvPoolTokens / BS;
  const sysBlocks = Math.floor(cfg.systemPromptTokens / BS);
  const maxSeqs = cal.engine.maxNumSeqs;
  const maxBatched = cal.engine.maxNumBatchedTokens;
  const maxLen = cal.engine.maxModelLen;
  const N = cfg.replicas;
  // Cost model constants (02 §6).
  const linFlopsPerTok = 2 * cal.model.params;
  const attnFlopsPerPair = 4 * cal.model.layers * cal.model.hiddenSize;
  const flopsPerMs = (cal.costModel.computeEfficiency * cal.gpu.peakDenseFp16Flops) / 1000;
  const bytesPerMs = (cal.costModel.bandwidthEfficiency * cal.gpu.memoryBandwidthBytesPerSecond) / 1000;
  const weightBytes = cal.model.weightBytes;
  const kvBytes = cal.model.kvBytesPerToken;
  const tO = cal.costModel.stepOverheadMs;

  let S: DayState;
  if (restore) {
    S = restore;
    // Checkpoints carry no output buffers; give the restored recorder fresh ones.
    const fresh = makeRecorder(N, cfg.bucketMs, cfg.histBucketMs, dayStartMs, opts.recordMetrics);
    S.rec.req = fresh.req;
    S.rec.tr = fresh.tr;
    S.rec.outScalars = fresh.outScalars;
    S.rec.outHist = fresh.outHist;
  } else {
    const reps: Replica[] = [];
    for (let r = 0; r < N; r++) reps.push(makeReplica(r, nBlocks, sysBlocks, dayStartMs, !opts.prefixCache ? 'none' : opts.prefixImpl === 'owner' ? 'owner' : 'map'));
    S = {
      day, dayStartMs, nowMs: dayStartMs, seq: 0, nextReqId: 0, rr: 0, nextSession: 0,
      sessions: new Map(), heap: [], tq: [], tqHead: 0, replicas: reps, counters: newCounters(),
      rec: makeRecorder(N, cfg.bucketMs, cfg.histBucketMs, dayStartMs, opts.recordMetrics),
      nextBucketMs: dayStartMs + cfg.bucketMs, nextHistMs: dayStartMs + cfg.histBucketMs,
      kvLevels: new Float64Array(N),
    };
  }
  const replicas = S.replicas;
  const rec = S.rec;
  const C = S.counters;
  const metrics = opts.recordMetrics;
  const detailAll = opts.detail === 'all';
  const detailTracked = opts.detail === 'tracked';
  const prefix = opts.prefixCache;
  const ownerImpl = opts.prefixImpl === 'owner';
  const cur = rec.cur;

  // ---------- heap of next-turn arrivals ----------
  function heapPush(ev: HeapEv): void {
    const h = S.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const a = h[p]!;
      if (a.t < ev.t || (a.t === ev.t && a.seq < ev.seq)) break;
      h[i] = a;
      i = p;
    }
    h[i] = ev;
  }
  function heapPop(): HeapEv {
    const h = S.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let c = l;
        if (r < n && (h[r]!.t < h[l]!.t || (h[r]!.t === h[l]!.t && h[r]!.seq < h[l]!.seq))) c = r;
        const cc = h[c]!;
        if (last.t < cc.t || (last.t === cc.t && last.seq < cc.seq)) break;
        h[i] = cc;
        i = c;
      }
      h[i] = last;
    }
    return top;
  }

  // ---------- metrics ----------
  function integrate(rep: Replica, t: number): void {
    const dt = t - rep.lastT;
    if (dt <= 0) return;
    rep.lastT = t;
    if (!metrics) return;
    const base = (rep.id + 1) * M;
    const run = rep.running.length;
    const wait = rep.waiting.length;
    const kv = (nBlocks - rep.numFree) / nBlocks;
    cur[base + MI.kvUsedFrac]! += kv * dt;
    cur[base + MI.running]! += run * dt;
    cur[base + MI.waiting]! += wait * dt;
    cur[base + MI.outstanding]! += (run + wait) * dt;
    if (rep.busy) {
      cur[base + MI.busyMs]! += dt;
      cur[base + MI.flops]! += rep.flopsRate * dt;
    }
  }
  function noteKv(rep: Replica): void {
    const kv = (nBlocks - rep.numFree) / nBlocks;
    S.kvLevels[rep.id] = kv;
    if (!metrics) return;
    const i = (rep.id + 1) * M + MI.kvUsedFracMax;
    if (kv > cur[i]!) cur[i] = kv;
  }
  function flushTo(t: number): void {
    while (t >= S.nextBucketMs) {
      const b = S.nextBucketMs;
      for (const rep of replicas) integrate(rep, b);
      if (metrics) flushScalarBucket(rec, N, S.kvLevels);
      if (b >= S.nextHistMs) {
        if (metrics) flushHistBucket(rec);
        S.nextHistMs += cfg.histBucketMs;
      }
      S.nextBucketMs += cfg.bucketMs;
    }
  }
  function add(rep: Replica, m: number, v: number): void {
    if (metrics) cur[(rep.id + 1) * M + m]! += v;
  }

  // ---------- KV blocks ----------
  function unlink(rep: Replica, b: number): void {
    const p = rep.prev[b]!;
    const n = rep.next[b]!;
    if (p >= 0) rep.next[p] = n;
    else rep.head = n;
    if (n >= 0) rep.prev[n] = p;
    else rep.tail = p;
  }
  function allocBlock(rep: Replica): number {
    const b = rep.head;
    unlink(rep, b);
    rep.numFree--;
    rep.ref[b] = 1;
    if (ownerImpl) {
      // Eviction is one typed-array write: lookup() validates each cached block's owner as it walks
      // the session's chain (truncating per-session JS arrays here instead cost ~40 ns per block).
      if (rep.owner[b]! >= 0) {
        rep.owner[b] = -1;
        C.evictions++;
        if (metrics) cur[(rep.id + 1) * M + MI.evictedBlocks]!++;
      }
      return b;
    }
    if (!prefix) return b;
    const k = rep.key[b]!;
    if (k >= 0) {
      rep.keyMap.delete(k);
      rep.key[b] = -1;
      C.evictions++;
      add(rep, MI.evictedBlocks, 1);
    }
    return b;
  }
  function releaseBlock(rep: Replica, b: number): void {
    if (--rep.ref[b]! > 0) return;
    // Append to the tail: most recently freed is evicted last (LRU).
    rep.prev[b] = rep.tail;
    rep.next[b] = -1;
    if (rep.tail >= 0) rep.next[rep.tail] = b;
    else rep.head = b;
    rep.tail = b;
    rep.numFree++;
  }
  function freeReqBlocks(rep: Replica, req: Req): void {
    const bl = req.blocks;
    if (prefix && ownerImpl) {
      // Chain the request's full blocks so the session's next turn can find them from one head.
      const h = req.hashed;
      for (let j = 0; j + 1 < h; j++) rep.nextInSeq[bl[j]!] = bl[j + 1]!;
      if (h > 0) rep.nextInSeq[bl[h - 1]!] = -1;
      const sess = S.sessions.get(req.session);
      if (sess) {
        if (!sess.cacheHead) sess.cacheHead = new Int32Array(N).fill(-1);
        sess.cacheHead[rep.id] = h > 0 ? bl[0]! : -1;
      }
    }
    // Reverse order, as vLLM does, so a request's tail blocks are evicted first.
    for (let i = bl.length - 1; i >= 0; i--) releaseBlock(rep, bl[i]!);
    bl.length = 0;
    req.hashed = 0;
  }
  // Smi keys (< 2^30) keep Map operations fast; a double key (day * 2^40 + ...) was ~2.5x slower.
  const smiKeys = opts.prefixSmiKeys !== false;
  function blockKey(session: number, idx: number): number {
    return smiKeys ? session * 8192 + idx : S.day * 2 ** 40 + session * 2 ** 14 + idx;
  }

  // ---------- recording ----------
  function transition(req: Req, state: number): void {
    req.state = state;
    if (req.record) pushTransition(rec, S.nowMs, req.id, req.analyst, req.replica, state);
  }
  function endRequest(rep: Replica, req: Req, outcome: number): void {
    req.done = true;
    req.endMs = S.nowMs;
    transition(req, outcome);
    if (req.record) pushRequest(rec, req, outcome);
    const sess = S.sessions.get(req.session)!;
    sess.inflight = null;
    sess.lastReplica = rep.id;
    if (outcome === REQUEST_STATE.finished) {
      C.finishes++;
      add(rep, MI.finished, 1);
      const e2e = req.endMs - req.arriveMs;
      const tpot = req.generated > 1 ? (req.endMs - req.firstTokenMs) / (req.generated - 1) : -1;
      add(rep, MI.e2eSumMs, e2e);
      add(rep, MI.e2eCount, 1);
      if (tpot >= 0) {
        add(rep, MI.tpotSumMs, tpot);
        add(rep, MI.tpotCount, 1);
      }
      if (metrics) recordFinish(rec, rep.id, tpot, e2e);
      sess.history = req.promptTokens - cfg.systemPromptTokens + req.generated;
      if (sess.pendingTurn > 0) {
        const t = sess.pendingTurn;
        sess.pendingTurn = 0;
        arrive(sess, t);
      } else if (sess.nextTurn > sess.turns) {
        dropSession(sess.id);
      }
    } else {
      C.timeouts++;
      add(rep, MI.timedOut, 1);
      sess.abandoned = true;
      C.abandoned++;
      dropSession(sess.id);
    }
  }

  function dropSession(id: number): void {
    S.sessions.delete(id);
  }

  // ---------- load ----------
  function arrive(sess: Session, turn: number): void {
    const msg = turnMessageTokens(cfg, day, sess.id, turn);
    let out = turnOutputTokens(cfg, day, sess.id, turn);
    let prompt = cfg.systemPromptTokens + sess.history + msg;
    if (prompt > maxLen - 16) prompt = maxLen - 16;
    if (prompt + out > maxLen) out = maxLen - prompt;
    const rep = replicas[S.rr++ % N]!;
    const req: Req = {
      id: S.nextReqId++, session: sess.id, analyst: sess.analyst, turn, replica: rep.id,
      prevReplica: turn === 1 ? -1 : sess.lastReplica, promptTokens: prompt, outputTarget: out,
      numTokens: prompt, computed: 0, generated: 0, cachedTokens: 0, blocks: [], hashed: 0, sched: 0,
      arriveMs: S.nowMs, dispatchMs: S.nowMs, firstTokenMs: NaN, endMs: NaN, preemptions: 0,
      recomputeLeft: 0, state: REQUEST_STATE.atRouter, aborted: false, done: false,
      record: detailAll || (detailTracked && sess.analyst === opts.trackedAnalyst),
    };
    C.arrivals++;
    sess.inflight = req;
    sess.nextTurn = turn + 1;
    transition(req, REQUEST_STATE.atRouter);
    if (metrics) {
      cur[MI.offered]! += 1;
      cur[MI.organic]! += 1;
    }
    integrate(rep, S.nowMs);
    rep.waiting.push(req);
    rep.dirty = true;
    add(rep, MI.dispatched, 1);
    transition(req, REQUEST_STATE.waiting);
    S.tq.push(req);
    if (turn < sess.turns) {
      heapPush({ t: S.nowMs + turnThinkMs(cfg, day, sess.id, turn), seq: S.seq++, session: sess.id, turn: turn + 1 });
    }
    if (rep.stepEndMs === Infinity) compose(rep);
  }

  function startSession(i: number): void {
    const sess: Session = {
      id: i, analyst: plan.analyst[i]!, turns: sessionTurns(cfg, day, i),
      history: 0, nextTurn: 1, inflight: null, pendingTurn: 0, abandoned: false, lastReplica: -1,
      cacheHead: null,
    };
    C.sessions++;
    S.sessions.set(i, sess);
    arrive(sess, 1);
  }

  function turnReady(ev: HeapEv): void {
    const sess = S.sessions.get(ev.session);
    if (!sess || sess.abandoned) return;
    if (sess.inflight) sess.pendingTurn = ev.turn;
    else arrive(sess, ev.turn);
  }

  function timeout(req: Req): void {
    if (req.done || req.firstTokenMs === req.firstTokenMs) return; // finished or has a first token
    const rep = replicas[req.replica]!;
    integrate(rep, S.nowMs);
    rep.dirty = true;
    const wi = rep.waiting.indexOf(req);
    if (wi >= 0) {
      rep.waiting.splice(wi, 1);
      freeReqBlocks(rep, req);
      noteKv(rep);
      endRequest(rep, req, REQUEST_STATE.timedOut);
    } else {
      req.aborted = true; // running: takes effect at the end of the in-flight step
    }
  }

  // ---------- scheduler ----------
  function preempt(rep: Replica, victim: Req): void {
    freeReqBlocks(rep, victim);
    victim.computed = 0;
    victim.numTokens = victim.promptTokens + victim.generated;
    victim.recomputeLeft = victim.numTokens;
    victim.preemptions++;
    C.preemptions++;
    add(rep, MI.preemptions, 1);
    rep.waiting.unshift(victim);
    transition(victim, REQUEST_STATE.preempted);
  }

  /** Prefix lookup for a request being admitted. Returns hit blocks (history only). */
  function lookup(rep: Replica, req: Req, hits: number[]): void {
    hits.length = 0;
    if (!prefix) return;
    const lastFull = Math.floor((req.numTokens - 1) / BS); // keep at least one token to compute
    if (ownerImpl) {
      const head = S.sessions.get(req.session)?.cacheHead;
      let b = head ? head[rep.id]! : -1;
      const k = lastFull - sysBlocks;
      for (let j = 0; j < k && b >= 0; j++) {
        if (rep.owner[b] !== req.session || rep.ownerIdx[b] !== sysBlocks + j) break;
        hits.push(b);
        b = rep.nextInSeq[b]!;
      }
      return;
    }
    for (let i = sysBlocks; i < lastFull; i++) {
      const b = rep.keyMap.get(blockKey(req.session, i));
      if (b === undefined) break;
      hits.push(b);
    }
  }
  const hitsTmp: number[] = [];

  function compose(rep: Replica): void {
    const now = S.nowMs;
    let budget = maxBatched;
    let P = 0;
    let D = 0;
    let recompute = 0;
    let pairs = 0;
    let kvRead = 0;
    let preempted = false;
    const running = rep.running;
    const stepReqs = rep.stepReqs;
    stepReqs.length = 0;
    let i = 0;
    while (i < running.length && budget > 0) {
      const req = running[i]!;
      if (req.aborted) { i++; continue; }
      const c = req.computed;
      const n = Math.min(req.numTokens - c, budget);
      const need = Math.ceil((c + n) / BS) - sysBlocks - req.blocks.length;
      let ok = true;
      while (need > rep.numFree) {
        const victim = running.pop()!;
        preempted = true;
        preempt(rep, victim);
        if (victim === req) { ok = false; break; }
      }
      if (!ok) break;
      for (let k = 0; k < need; k++) req.blocks.push(allocBlock(rep));
      req.sched = n;
      stepReqs.push(req);
      budget -= n;
      if (n === 1 && req.generated > 0) D++;
      else {
        P += n;
        if (req.recomputeLeft > 0) recompute += Math.min(n, req.recomputeLeft);
      }
      pairs += n * c + (n * (n + 1)) / 2;
      kvRead += c + n;
      i++;
    }
    if (!preempted) {
      const waiting = rep.waiting;
      while (waiting.length > 0 && budget > 0 && running.length < maxSeqs) {
        const req = waiting[0]!;
        // Prefix: the system prompt's full blocks are always cached; history per lookup.
        lookup(rep, req, hitsTmp);
        const hits = hitsTmp.length;
        let hitFreeable = 0;
        for (let h = 0; h < hits; h++) if (rep.ref[hitsTmp[h]!] === 0) hitFreeable++;
        const c = (sysBlocks + hits) * BS;
        const n = Math.min(req.numTokens - c, budget);
        const need = Math.ceil((c + n) / BS) - sysBlocks - hits;
        if (need > rep.numFree - hitFreeable) break;
        waiting.shift();
        for (let h = 0; h < hits; h++) {
          const b = hitsTmp[h]!;
          if (rep.ref[b] === 0) { unlink(rep, b); rep.numFree--; }
          rep.ref[b]!++;
          req.blocks.push(b);
        }
        req.hashed = hits;
        for (let k = 0; k < need; k++) req.blocks.push(allocBlock(rep));
        const firstAdmit = req.preemptions === 0;
        if (firstAdmit) {
          req.cachedTokens = c;
          C.admits++;
        } else if (req.recomputeLeft > 0) {
          // Cache hits on recompute reduce the recomputed work.
          req.recomputeLeft = Math.max(0, req.recomputeLeft - c);
        }
        C.prefixQueryTokens += req.numTokens;
        C.prefixHitTokens += c;
        add(rep, MI.prefixQueryTokens, req.numTokens);
        add(rep, MI.prefixHitTokens, c);
        if (req.turn > 1) {
          add(rep, MI.returningQueryTokens, req.numTokens);
          add(rep, MI.returningHitTokens, c);
        }
        req.computed = c;
        running.push(req);
        transition(req, REQUEST_STATE.prefill);
        req.sched = n;
        stepReqs.push(req);
        budget -= n;
        P += n;
        if (req.recomputeLeft > 0) recompute += Math.min(n, req.recomputeLeft);
        pairs += n * c + (n * (n + 1)) / 2;
        kvRead += c + n;
      }
    }
    noteKv(rep);
    if (stepReqs.length === 0) {
      if (rep.waiting.length > 0 && running.length === 0) throw new Error('deadlock: head request cannot fit');
      rep.stepEndMs = Infinity;
      rep.busy = 0;
      rep.flopsRate = 0;
      rep.prevDecodeOnly = false;
      return;
    }
    const flops = linFlopsPerTok * (P + D) + attnFlopsPerPair * pairs;
    const bytes = weightBytes + kvBytes * (kvRead + P + D);
    const stepMs = tO + Math.max(flops / flopsPerMs, bytes / bytesPerMs);
    rep.stepMs = stepMs;
    rep.stepEndMs = now + stepMs;
    rep.stepPrefill = P;
    rep.stepDecode = D;
    rep.stepRecompute = recompute;
    rep.flopsRate = flops / stepMs;
    rep.busy = 1;
    C.steps++;
    C.reqSteps += stepReqs.length;
    const decodeOnly = P === 0;
    if (decodeOnly) C.decodeOnlySteps++;
    else C.prefillSteps++;
    if (!(decodeOnly && rep.prevDecodeOnly && !rep.dirty && !preempted)) C.segments++;
    rep.prevDecodeOnly = decodeOnly;
    rep.dirty = false;
  }

  function stepEnd(rep: Replica): void {
    integrate(rep, S.nowMs);
    const now = S.nowMs;
    const stepReqs = rep.stepReqs;
    let removed = false;
    C.prefillTokens += rep.stepPrefill;
    C.decodeTokens += rep.stepDecode;
    C.recomputedTokens += rep.stepRecompute;
    add(rep, MI.prefillTokens, rep.stepPrefill);
    add(rep, MI.decodeTokens, rep.stepDecode);
    add(rep, MI.recomputedPrefillTokens, rep.stepRecompute);
    for (let i = 0; i < stepReqs.length; i++) {
      const req = stepReqs[i]!;
      if (req.aborted) continue;
      const n = req.sched;
      req.computed += n;
      if (req.recomputeLeft > 0) req.recomputeLeft = Math.max(0, req.recomputeLeft - n);
      if (prefix) {
        const full = Math.floor(req.computed / BS) - sysBlocks;
        for (let j = req.hashed; j < full; j++) {
          const b = req.blocks[j]!;
          if (ownerImpl) {
            if (rep.owner[b]! < 0) {
              rep.owner[b] = req.session;
              rep.ownerIdx[b] = sysBlocks + j;
            }
            continue;
          }
          const k = blockKey(req.session, sysBlocks + j);
          if (rep.key[b]! < 0 && !rep.keyMap.has(k)) {
            rep.keyMap.set(k, b);
            rep.key[b] = k;
          }
        }
        if (full > req.hashed) req.hashed = full;
      }
      if (req.computed === req.numTokens) {
        req.generated++;
        req.numTokens++;
        if (req.generated === 1) {
          req.firstTokenMs = now;
          C.firstTokens++;
          rep.dirty = true;
          const ttft = now - req.arriveMs;
          add(rep, MI.ttftSumMs, ttft);
          add(rep, MI.ttftCount, 1);
          if (metrics) recordTtft(rec, rep.id, ttft);
          transition(req, REQUEST_STATE.decode);
        } else if (req.state !== REQUEST_STATE.decode) {
          transition(req, REQUEST_STATE.decode); // resumed after recompute
          rep.dirty = true;
        }
        if (req.generated >= req.outputTarget) {
          req.done = true;
          removed = true;
        }
      }
    }
    // Remove finished and aborted requests from running.
    const running = rep.running;
    let anyAborted = false;
    for (let i = 0; i < running.length; i++) if (running[i]!.aborted) { anyAborted = true; break; }
    if (removed || anyAborted) {
      rep.dirty = true;
      let w = 0;
      for (let i = 0; i < running.length; i++) {
        const req = running[i]!;
        if (req.aborted) {
          freeReqBlocks(rep, req);
          req.done = false;
          endRequest(rep, req, REQUEST_STATE.timedOut);
        } else if (req.done) {
          freeReqBlocks(rep, req);
          req.done = false;
          endRequest(rep, req, REQUEST_STATE.finished);
        } else running[w++] = req;
      }
      running.length = w;
    }
    compose(rep);
  }

  // ---------- main loop ----------
  function advance(untilMs: number): ResultChunk {
    const fromMs = S.nowMs;
    const dayEnd = dayStartMs + DAY_MS;
    const until = Math.min(untilMs, dayEnd);
    const starts = plan.startMs;
    for (;;) {
      let t = Infinity;
      let kind = 0; // 1 step end, 2 timeout, 3 turn, 4 session start
      let which: Replica | null = null;
      for (let r = 0; r < N; r++) {
        const rep = replicas[r]!;
        if (rep.stepEndMs < t) { t = rep.stepEndMs; kind = 1; which = rep; }
      }
      if (S.tqHead < S.tq.length) {
        const d = S.tq[S.tqHead]!.arriveMs + cfg.timeoutToFirstTokenMs;
        if (d < t) { t = d; kind = 2; }
      }
      if (S.heap.length > 0 && S.heap[0]!.t < t) { t = S.heap[0]!.t; kind = 3; }
      if (S.nextSession < starts.length && starts[S.nextSession]! < t) { t = starts[S.nextSession]!; kind = 4; }
      if (t >= until) break;
      flushTo(t);
      S.nowMs = t;
      C.heapEvents++;
      if (kind === 1) stepEnd(which!);
      else if (kind === 2) {
        const req = S.tq[S.tqHead++]!;
        if (S.tqHead > 4096 && S.tqHead * 2 > S.tq.length) { S.tq = S.tq.slice(S.tqHead); S.tqHead = 0; }
        timeout(req);
      } else if (kind === 3) turnReady(heapPop());
      else startSession(S.nextSession++);
    }
    flushTo(until);
    for (const rep of replicas) integrate(rep, until);
    S.nowMs = until;
    return emitChunk(rec, day, fromMs, until, N, opts.detail === 'all' ? 'all' : 'tracked');
  }

  function checkpointState(): DayState {
    // Drop pending timeouts for requests that already have a first token or ended.
    S.tq = S.tq.slice(S.tqHead).filter((r) => !r.done && r.firstTokenMs !== r.firstTokenMs);
    S.tqHead = 0;
    const empty = makeRecorder(N, cfg.bucketMs, cfg.histBucketMs, dayStartMs, opts.recordMetrics);
    return {
      ...S,
      rec: {
        ...S.rec,
        outScalars: { a: new Float64Array(0), n: 0 },
        outHist: empty.outHist,
        req: { ...empty.req, cap: 0, u32: {}, f64: {}, u16: {}, u8: {}, i8: {} },
        tr: { ...empty.tr, cap: 0, u32: {}, f64: {}, u16: {}, u8: {}, i8: {} },
      },
    };
  }

  return { state: S, plan, advance, checkpointState };
}
