// The load generator and client as an engine module (00-build E6; 02 §8; K6, K8, K21, K23).
// See index.ts for the behaviour and the bounds.

import type { InjectedEvent } from '../api.ts';
import { NO_EVENT, TOPIC, defineModule, type Ctx, type DayState } from '../core/index.ts';
import { REQUEST_KIND } from '../shared/index.ts';
import { Source, u01, uniformInt } from '../rng/index.ts';
import {
  acceptCandidate,
  advanceCursor,
  buildEnvelope,
  createCursor,
  effectiveMultiplier,
  type ArrivalEnvelope,
  type CandidateCursor,
} from './arrivals.ts';
import { onFirstToken, onRequestEnded, onTimeout, prepareTurn, sendRequest } from './client.ts';
import { EXTRA_SESSION_BASE, LOAD_KIND, LOAD_PRIORITY } from './ids.ts';
import { assertLoadInvariants } from './invariants.ts';
import { drawTurns, sessionSystemPrompt } from './script.ts';
import { createSessionTable, openSession, type SessionTable } from './sessions.ts';

/** Counts since the day's start, for tests and tooling. E9 observes requests through topics. */
export interface LoadStats {
  candidates: number;
  sessions: number;
  /** First attempts of organic turns. */
  turns: number;
  /** First attempts of extra requests. */
  extras: number;
  retries: number;
  completed: number;
  abandoned: number;
  cutOff: number;
}

export interface LoadSlice {
  env: ArrivalEnvelope;
  cursor: CandidateCursor;
  /** The pending candidate event; NO_EVENT once the day's candidates are exhausted. */
  candidateEv: number;
  /** loadSpike events so far today, in patch order. */
  spikeMult: number[];
  spikeActive: number[];
  spikeEndEv: number[];
  /** Product of the active spikes' multipliers. */
  spikeProduct: number;
  /** Extra requests injected so far today. */
  extrasInjected: number;
  sessions: SessionTable;
  /** Session record by request slot; -1 when the slot is not in flight. Sized to the request table. */
  recOfSlot: Int32Array;
  stats: LoadStats;
}

declare module '../core/types.ts' {
  interface DayState {
    load: LoadSlice;
  }
}

function scheduleCandidate(L: LoadSlice, ctx: Ctx): void {
  const cfg = ctx.input.config;
  L.candidateEv = advanceCursor(L.env, cfg.seed, ctx.input.day, L.cursor)
    ? ctx.schedule(L.cursor.atMs, LOAD_KIND.candidate, L.cursor.index)
    : NO_EVENT;
  if (L.candidateEv === NO_EVENT) L.cursor.atMs = Infinity;
}

/** An accepted candidate: a new session whose first turn arrives now. */
function startSession(state: DayState, ctx: Ctx, session: number): void {
  const L = state.load;
  const p = state.core.params;
  const cfg = ctx.input.config;
  const seed = cfg.seed;
  const day = ctx.input.day;
  const analysts = cfg.analystsPerReplica * cfg.replicas;
  const rec = openSession(L.sessions);
  const S = L.sessions;
  S.id[rec] = session;
  S.analyst[rec] = uniformInt(u01(seed, Source.sessionAnalyst, day, session), analysts);
  S.kind[rec] = REQUEST_KIND.turn;
  S.startMs[rec] = ctx.nowMs;
  // Workload parameters are those in effect at the session's start (TunableParams).
  S.turns[rec] = drawTurns(seed, day, session, p.turnsPerSessionMean);
  S.systemPrompt[rec] = sessionSystemPrompt(
    p.systemPromptTokens,
    ctx.input.calibration.engine.maxModelLen,
  );
  S.messageMedian[rec] = p.messageTokensMedian;
  S.outputMedian[rec] = p.outputTokensMedian;
  S.thinkMedianMs[rec] = p.thinkTimeMedianMs;
  // Turn 1 always fits: sessionSystemPrompt leaves room for a message and an output token.
  prepareTurn(state, ctx, rec, 1);
  L.stats.sessions++;
  sendRequest(state, ctx, rec);
}

function onCandidate(state: DayState, index: number, ctx: Ctx): void {
  const L = state.load;
  const c = L.cursor;
  if (index !== c.index || ctx.nowMs !== c.atMs) throw new Error('load: stale candidate event');
  const cfg = ctx.input.config;
  const m = effectiveMultiplier(state.core.params.loadMultiplier, L.spikeProduct);
  const accept = acceptCandidate(L.env, cfg.seed, ctx.input.day, c, m);
  L.stats.candidates++;
  scheduleCandidate(L, ctx);
  if (accept) startSession(state, ctx, index);
}

function onPendingSend(state: DayState, rec: number, sessionId: number): void {
  const S = state.load.sessions;
  if (S.open[rec] !== 1 || S.id[rec] !== sessionId || S.slot[rec] !== -1) {
    throw new Error(`load: stale arrival event for session ${sessionId}`);
  }
  S.ev[rec] = NO_EVENT;
}

function recomputeSpikes(L: LoadSlice): void {
  let product = 1;
  for (let i = 0; i < L.spikeMult.length; i++)
    if (L.spikeActive[i] === 1) product *= L.spikeMult[i]!;
  L.spikeProduct = product;
}

function injectExtra(
  state: DayState,
  ctx: Ctx,
  event: Extract<InjectedEvent, { type: 'extraRequest' }>,
): void {
  if (!(Number.isFinite(event.promptTokens) && Number.isFinite(event.outputTokens))) {
    throw new RangeError('extraRequest needs finite promptTokens and outputTokens');
  }
  const L = state.load;
  const cfg = ctx.input.config;
  const maxLen = ctx.input.calibration.engine.maxModelLen;
  const n = L.extrasInjected++;
  const rec = openSession(L.sessions);
  const S = L.sessions;
  let analyst = event.analyst === 'tracked' ? ctx.input.trackedAnalyst : event.analyst;
  // No tracked analyst: a keyed draw, so tracking never changes the dynamics.
  analyst ??= uniformInt(
    u01(cfg.seed, Source.extraRequest, ctx.input.day, n),
    cfg.analystsPerReplica * cfg.replicas,
  );
  const prompt = Math.min(Math.max(1, Math.round(event.promptTokens)), Math.max(1, maxLen - 1));
  const sys = Math.min(sessionSystemPrompt(state.core.params.systemPromptTokens, maxLen), prompt);
  S.id[rec] = EXTRA_SESSION_BASE + n;
  S.analyst[rec] = analyst;
  S.kind[rec] = REQUEST_KIND.extra;
  S.startMs[rec] = ctx.nowMs;
  S.turns[rec] = 1;
  S.turn[rec] = 1;
  S.systemPrompt[rec] = sys;
  S.message[rec] = prompt - sys;
  S.output[rec] = Math.max(1, Math.min(Math.round(event.outputTokens), maxLen - prompt));
  S.ev[rec] = ctx.schedule(ctx.nowMs, LOAD_KIND.extra, rec, S.id[rec]!);
}

function injectSpike(state: DayState, ctx: Ctx, multiplier: number, durationMs: number): void {
  if (!(multiplier >= 0 && Number.isFinite(multiplier) && durationMs > 0)) {
    throw new RangeError(`loadSpike needs a finite multiplier >= 0 and a positive duration`);
  }
  const L = state.load;
  const i = L.spikeMult.length;
  L.spikeMult.push(multiplier);
  L.spikeActive.push(1);
  // A spike that outlasts the day stays active to its end (schedule returns NO_EVENT).
  L.spikeEndEv.push(ctx.schedule(ctx.nowMs + durationMs, LOAD_KIND.spikeEnd, i));
  recomputeSpikes(L);
}

export const loadModule = defineModule({
  name: 'load',
  init(_state, ctx) {
    if (!(ctx.input.calibration.engine.maxModelLen >= 2)) {
      throw new RangeError('Load generator: calibration maxModelLen must be at least 2 tokens');
    }
    const slice: LoadSlice = {
      env: buildEnvelope(ctx.input.config, ctx.input.day),
      cursor: createCursor(),
      candidateEv: NO_EVENT,
      spikeMult: [],
      spikeActive: [],
      spikeEndEv: [],
      spikeProduct: 1,
      extrasInjected: 0,
      sessions: createSessionTable(),
      recOfSlot: new Int32Array(0),
      stats: {
        candidates: 0,
        sessions: 0,
        turns: 0,
        extras: 0,
        retries: 0,
        completed: 0,
        abandoned: 0,
        cutOff: 0,
      },
    };
    scheduleCandidate(slice, ctx);
    return slice;
  },
  events: [
    {
      kind: LOAD_KIND.candidate,
      name: 'load.candidate',
      priority: LOAD_PRIORITY.send,
      handle: (state, ev, ctx) => onCandidate(state, ev.a, ctx),
    },
    {
      kind: LOAD_KIND.nextTurn,
      name: 'load.nextTurn',
      priority: LOAD_PRIORITY.send,
      handle(state, ev, ctx) {
        onPendingSend(state, ev.a, ev.b);
        sendRequest(state, ctx, ev.a);
      },
    },
    {
      kind: LOAD_KIND.retry,
      name: 'load.retry',
      priority: LOAD_PRIORITY.send,
      handle(state, ev, ctx) {
        onPendingSend(state, ev.a, ev.b);
        sendRequest(state, ctx, ev.a);
      },
    },
    {
      kind: LOAD_KIND.extra,
      name: 'load.extra',
      priority: LOAD_PRIORITY.send,
      handle(state, ev, ctx) {
        onPendingSend(state, ev.a, ev.b);
        sendRequest(state, ctx, ev.a);
      },
    },
    {
      kind: LOAD_KIND.spikeEnd,
      name: 'load.spikeEnd',
      priority: LOAD_PRIORITY.spikeEnd,
      handle(state, ev) {
        const L = state.load;
        L.spikeActive[ev.a] = 0;
        L.spikeEndEv[ev.a] = NO_EVENT;
        recomputeSpikes(L);
      },
    },
    {
      kind: LOAD_KIND.timeout,
      name: 'load.timeout',
      priority: LOAD_PRIORITY.timeout,
      handle: (state, ev, ctx) => onTimeout(state, ev.a, ev.b, ctx),
    },
  ],
  notices: [
    { topic: TOPIC.firstToken, handle: (state, n, ctx) => onFirstToken(state, n.a, ctx) },
    { topic: TOPIC.requestEnded, handle: (state, n, ctx) => onRequestEnded(state, n.a, n.b, ctx) },
  ],
  onInjected(state, event, ctx) {
    if (event.type === 'extraRequest') injectExtra(state, ctx, event);
    else if (event.type === 'loadSpike')
      injectSpike(state, ctx, event.multiplier, event.durationMs);
  },
  assertInvariants: assertLoadInvariants,
});
