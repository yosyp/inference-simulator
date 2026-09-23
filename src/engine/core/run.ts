// One day run: the advance loop, the handler context, checkpoints (00-build E2; 02 §5; 04 §3).
//
// Boundary rule. advance(untilMs) with end = min(untilMs, dayEndMs):
// 1. Repeatedly take the earliest of the next pending patch and the next queued event. A patch wins
//    a tie. Stop once that time is >= end; events and patches exactly at `end` stay pending.
// 2. Before anything at time t runs, close every scalar bucket whose boundary b <= t, in order,
//    calling onBucketEnd with nowMs = b. So an event at exactly a boundary lands in the new bucket.
// 3. Set nowMs = t and apply the patch or dispatch the event.
// 4. After the loop, close buckets with boundaries <= end, set nowMs = end, and build the chunk.
// Events at or after dayEndMs never run (schedule drops them). Splitting an advance into smaller
// ones therefore runs the same handlers in the same order with the same state.

import type { DayRunInput } from '../api.ts';
import { emptyChunk } from './chunk.ts';
import { PATCH_KIND } from './ids.ts';
import { applySetChanges } from './patches.ts';
import { assertPlainData } from './plain.ts';
import {
  NO_EVENT,
  assertQueue,
  queueCancel,
  queueIsPending,
  queueMaxLiveAt,
  queueMinLiveAt,
  queuePeekAt,
  queuePush,
  queueTake,
  type EventHandle,
  type EventView,
} from './queue.ts';
import { isTopic, type Registry } from './registry.ts';
import type { CoreDayRun, Ctx, DayState, NoticeView, RunnerOptions } from './types.ts';

// The engine's lib is ES2023 without DOM or WebWorker types; structuredClone exists in every
// runtime we target (browsers, workers, Node 17+).
declare function structuredClone<T>(value: T): T;

type MutableCtx = { -readonly [K in keyof Ctx]: Ctx[K] };

/** Wraps `state` in a live run. With `init`, builds each module's slice first (a fresh day). */
export function openRun(
  reg: Registry,
  input: DayRunInput,
  state: DayState,
  options: RunnerOptions,
  init: boolean,
): CoreDayRun {
  const core = state.core;
  const q = core.queue;
  const pat = core.patches;
  const bucketMs = input.config.bucketMs;
  const { handlers, priorities } = reg;
  const trace = options.trace;
  const everyEvent = options.assertEveryEvent === true;
  const view: EventView = { atMs: 0, kind: 0, a: 0, b: 0, handle: NO_EVENT };
  const noticeViews: NoticeView[] = [];
  let depth = 0;
  let failure: unknown = undefined;

  function schedule(atMs: number, kind: number, a = 0, b = 0): EventHandle {
    const priority = priorities[kind];
    if (priority === undefined || priority < 0) {
      throw new Error(`schedule: event kind ${kind} is not registered`);
    }
    if (!(atMs >= ctx.nowMs)) {
      throw new RangeError(
        `schedule: ${reg.kindNames[kind]} at ${atMs} is before now (${ctx.nowMs})`,
      );
    }
    if (atMs >= core.dayEndMs) return NO_EVENT;
    return queuePush(q, atMs, priority, kind, a, b);
  }

  function notify(topic: number, a = 0, b = 0): void {
    const subs = reg.subscribers[topic];
    if (subs === undefined) {
      if (!isTopic(topic)) throw new Error(`notify: topic ${topic} is out of range`);
      return;
    }
    const n = (noticeViews[depth] ??= { topic: 0, a: 0, b: 0 });
    n.topic = topic;
    n.a = a;
    n.b = b;
    depth++;
    try {
      for (const handle of subs) handle(state, n, ctx);
    } finally {
      depth--;
    }
  }

  const ctx: MutableCtx = {
    nowMs: core.nowMs,
    input,
    dayStartMs: core.dayStartMs,
    dayEndMs: core.dayEndMs,
    schedule,
    cancel: (handle) => queueCancel(q, handle),
    reschedule: (handle, atMs, kind, a, b) => {
      queueCancel(q, handle);
      return schedule(atMs, kind, a, b);
    },
    isPending: (handle) => queueIsPending(q, handle),
    notify,
  };

  function closeBuckets(t: number): void {
    for (let b = core.closedToMs + bucketMs; b <= t; b += bucketMs) {
      core.nowMs = ctx.nowMs = b;
      for (const m of reg.bucketHooks) m.onBucketEnd!(state, b, ctx);
      core.closedToMs = b;
    }
  }

  function applyPatch(index: number): void {
    const p = pat.inDay[index]!;
    pat.next = index + 1;
    if (trace) {
      view.atMs = p.atMs;
      view.kind = PATCH_KIND;
      view.a = index;
      view.b = 0;
      view.handle = NO_EVENT;
      trace(view, state);
    }
    if (p.kind === 'set') {
      applySetChanges(core.params, p.changes);
      for (const m of reg.paramHooks) m.onParams!(state, p.changes, ctx);
    } else {
      for (const m of reg.injectHooks) m.onInjected!(state, p.event, ctx);
    }
  }

  function checkAll(full: boolean): void {
    assertCore(state, bucketMs);
    for (const m of reg.invariantHooks) m.assertInvariants!(state, ctx);
    if (full) assertPlainData(state);
  }

  function assertUsable(what: string): void {
    if (failure !== undefined) {
      throw new Error(`${what}: this day run threw earlier and its state is unusable`, {
        cause: failure,
      });
    }
  }

  function advance(untilMs: number) {
    assertUsable('advance');
    if (!(untilMs >= core.nowMs)) {
      throw new RangeError(`advance: ${untilMs} is before now (${core.nowMs})`);
    }
    const end = Math.min(untilMs, core.dayEndMs);
    const fromMs = core.nowMs;
    const bucketsFromMs = core.closedToMs;
    try {
      let nextBoundary = core.closedToMs + bucketMs;
      for (;;) {
        const tEv = queuePeekAt(q);
        const tPatch = pat.next < pat.inDay.length ? pat.inDay[pat.next]!.atMs : Infinity;
        const isPatch = tPatch <= tEv;
        const t = isPatch ? tPatch : tEv;
        if (!(t < end)) break;
        if (t >= nextBoundary) {
          // Bucket hooks may schedule, so pick the next item again afterwards.
          closeBuckets(t);
          nextBoundary = core.closedToMs + bucketMs;
          continue;
        }
        core.nowMs = ctx.nowMs = t;
        if (isPatch) {
          applyPatch(pat.next);
        } else {
          queueTake(q, view);
          if (trace) trace(view, state);
          handlers[view.kind]!(state, view, ctx);
        }
        if (everyEvent) checkAll(false);
      }
      closeBuckets(end);
      core.nowMs = ctx.nowMs = end;
      const span = { fromMs, toMs: end, bucketsFromMs, bucketsToMs: core.closedToMs };
      return reg.producer ? reg.producer.produceChunk!(state, span, ctx) : emptyChunk(input, span);
    } catch (e) {
      failure = e;
      throw e;
    }
  }

  if (init) {
    // Standard morning state (K21): each slice is built in module order. If init throws, no run
    // is returned.
    const slices = state as unknown as Record<string, unknown>;
    for (const m of reg.modules) slices[m.name] = m.init(state, ctx);
  }

  return {
    get day() {
      return core.day;
    },
    get nowMs() {
      return core.nowMs;
    },
    get done() {
      return core.nowMs >= core.dayEndMs;
    },
    state,
    dayEndMs: core.dayEndMs,
    advance,
    checkpoint() {
      assertUsable('checkpoint');
      return { day: core.day, atMs: core.nowMs, state: structuredClone(state) };
    },
    assertInvariants() {
      assertUsable('assertInvariants');
      checkAll(true);
    },
  };
}

/** Core invariants; none of these mutate state (the queue check is O(n)). */
export function assertCore(state: DayState, bucketMs: number): void {
  const c = state.core;
  const fail = (msg: string): never => {
    throw new Error(`Core invariant (day ${c.day}, now ${c.nowMs}): ${msg}`);
  };
  if (!(c.nowMs >= c.dayStartMs && c.nowMs <= c.dayEndMs)) fail('now is outside the day');
  if ((c.closedToMs - c.dayStartMs) % bucketMs !== 0) fail('closedToMs is not a bucket boundary');
  if (!(c.closedToMs <= c.nowMs && c.nowMs < c.closedToMs + bucketMs)) {
    fail(`closedToMs ${c.closedToMs} does not trail now by less than a bucket`);
  }
  assertQueue(c.queue);
  if (queueMinLiveAt(c.queue) < c.nowMs) fail('a pending event is in the past');
  if (queueMaxLiveAt(c.queue) >= c.dayEndMs) fail('a pending event is after the day');
  const p = c.patches;
  if (!(p.next >= 0 && p.next <= p.inDay.length)) fail('patch cursor out of range');
  for (let i = 0; i < p.inDay.length; i++) {
    const at = p.inDay[i]!.atMs;
    if (i > 0 && at < p.inDay[i - 1]!.atMs) fail('in-day patches are not sorted');
    if (i < p.next ? at > c.nowMs : at < c.nowMs) fail(`patch ${i} at ${at} applied out of time`);
  }
}
