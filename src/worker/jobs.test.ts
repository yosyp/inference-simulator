// Detail windows, traces, focus, and reset on the engine host.

import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import { runHeadlessDay } from '../engine/headless.ts';
import { REQUEST_STATE } from '../engine/results.ts';
import { DAY_MS, simMs, type DayIndex } from '../engine/time.ts';
import type { WorkerToMain } from './protocol.ts';
import {
  createTestHost,
  initMsg,
  messageDay,
  requestRows,
  scenarioOf,
  smallConfig,
  transitionRows,
} from './testkit.ts';

type Msg<T extends WorkerToMain['type']> = Extract<WorkerToMain, { type: T }>;

function ofType<T extends WorkerToMain['type']>(out: readonly WorkerToMain[], type: T): Msg<T>[] {
  return out.filter((m): m is Msg<T> => m.type === type);
}

const FOCUS = simMs(2, 10, 28);
const TRACKED = { rule: 'fixed', analyst: 3 } as const;

/** A headless reference day: same config, every request recorded. */
function reference(config: ReturnType<typeof smallConfig>, day: DayIndex, tracked: number | null) {
  return runHeadlessDay({ config, calibration, detail: 'all' }, day, tracked);
}

describe('engine host: requestDetail', { timeout: 60_000 }, () => {
  // Busy enough that requests are in flight at any peak instant.
  const config = { ...smallConfig(3, 60), sessionsPerAnalystPerDay: 12 };

  it('re-simulates the window with detail all, in-flight requests first, one reply per tag', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    // Compute Wednesday to its end (and a bit more).
    t.runUntil(() => ofType(t.out, 'dayComplete').length > 0);
    const from = simMs(2, 10, 30);
    const to = simMs(2, 10, 40);
    const before = t.out.length;
    t.send({ type: 'requestDetail', runId: 1, requestTag: 7, fromMs: from, toMs: to });
    t.runUntil(() => ofType(t.out.slice(before), 'detail').length > 0);
    const replies = ofType(t.out.slice(before), 'detail');
    expect(replies).toHaveLength(1);
    const d = replies[0]!;
    expect(d.requestTag).toBe(7);
    expect(d.chunk.fromMs).toBe(from);
    expect(d.chunk.toMs).toBe(to);
    expect(d.chunk.requests.scope).toBe('all');
    expect(d.chunk.transitions.scope).toBe('all');

    const ref = reference(config, 2, 3);
    const refRequests = ref.chunks.flatMap((c) => requestRows(c.requests));
    const refTransitions = ref.chunks.flatMap((c) => transitionRows(c.transitions));
    // In flight at fromMs: arrived before it and ended at or after it.
    const live = refRequests.filter((r) => r[7]! < from && r[10]! >= from).map((r) => r[0]);
    const rows = transitionRows(d.chunk.transitions);
    const lead = rows.filter((r) => r[0] === from).slice(0, live.length);
    expect(live.length).toBeGreaterThan(0);
    expect(lead.map((r) => r[1]).sort((a, b) => a! - b!)).toEqual(
      [...live].sort((a, b) => a! - b!),
    );
    // Each synthetic row carries the request's state and replica at fromMs.
    for (const r of lead) {
      const last = refTransitions.filter((x) => x[1] === r[1] && x[0]! < from).at(-1)!;
      expect([r[3], r[4]]).toEqual([last[3], last[4]]);
      expect(r[4]).toBeLessThan(REQUEST_STATE.finished);
    }
    // The rest is exactly the window of an all-detail run.
    expect(rows.slice(live.length)).toEqual(
      refTransitions.filter((x) => x[0]! >= from && x[0]! < to),
    );
    expect(requestRows(d.chunk.requests)).toEqual(
      refRequests.filter((r) => r[10]! >= from && r[10]! < to),
    );
  });

  it('answers the next window from the previous replay, and answers stale tags on a fork', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    t.runUntil(() => ofType(t.out, 'dayComplete').length > 0);
    const w = (h: number, m: number) => simMs(2, h, m);
    t.send({ type: 'requestDetail', runId: 1, requestTag: 1, fromMs: w(11, 0), toMs: w(11, 10) });
    t.send({ type: 'requestDetail', runId: 1, requestTag: 2, fromMs: w(11, 10), toMs: w(11, 20) });
    t.send({ type: 'requestDetail', runId: 1, requestTag: 3, fromMs: w(12, 0), toMs: w(12, 10) });
    t.runUntil(() => ofType(t.out, 'detail').length >= 1);
    // A fork at 11:45 invalidates the 12:00 window; it is answered at once, empty.
    t.send({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'set', atMs: w(11, 45), changes: { loadMultiplier: 1.5 } },
    });
    t.runAll();
    const replies = ofType(t.out, 'detail');
    expect(replies.map((r) => r.requestTag).sort()).toEqual([1, 2, 3]);
    const third = replies.find((r) => r.requestTag === 3)!;
    expect(third.chunk.requests.count + third.chunk.transitions.count).toBe(0);
    const second = replies.find((r) => r.requestTag === 2)!;
    expect(second.chunk.transitions.count).toBeGreaterThan(0);
  });

  it('answers at once, empty, when the run already records every request', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(smallConfig(2)), calibration, FOCUS));
    t.runAll(30);
    const before = t.out.length;
    t.send({
      type: 'requestDetail',
      runId: 1,
      requestTag: 9,
      fromMs: simMs(2, 7),
      toMs: simMs(2, 7, 10),
    });
    const reply = t.out[before]!;
    expect(reply.type).toBe('detail');
    if (reply.type === 'detail') {
      expect(reply.requestTag).toBe(9);
      expect(reply.chunk.transitions.count).toBe(0);
    }
  });
});

describe('engine host: track', { timeout: 60_000 }, () => {
  const config = smallConfig(3, 60);

  it('posts one trace per computed day, focus day first, spanning the day', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config, [], TRACKED), calibration, FOCUS));
    // Wednesday and Thursday are done; Friday is under way.
    t.runUntil(() =>
      ofType(t.out, 'chunk').some((m) => m.chunk.day === 4 && m.chunk.toMs >= simMs(4, 10)),
    );
    const before = t.out.length;
    t.send({ type: 'track', runId: 1, analyst: 17 });
    t.runAll();
    const after = t.out.slice(before);
    const traces = ofType(after, 'trace');
    expect(traces.map((m) => m.day)).toEqual([2, 3, 4]);
    for (const tr of traces) {
      expect(tr.analyst).toBe(17);
      expect(tr.chunk.fromMs).toBe(tr.day * DAY_MS);
      expect(tr.chunk.requests.scope).toBe('tracked');
    }
    expect(traces[0]!.chunk.toMs).toBe(3 * DAY_MS);
    expect(traces[1]!.chunk.toMs).toBe(4 * DAY_MS);
    // Wednesday's trace equals the analyst's records in an all-detail run.
    const ref = reference(config, 2, 17);
    const mine = ref.chunks.flatMap((c) => requestRows(c.requests)).filter((r) => r[2] === 17);
    expect(mine.length).toBeGreaterThan(0);
    expect(requestRows(traces[0]!.chunk.requests)).toEqual(mine);
    // Friday was mid-stream: its trace covers what was sent; later main chunks carry analyst 17.
    const friTrace = traces[2]!;
    const friLater = ofType(after, 'chunk').filter((m) => m.chunk.day === 4);
    expect(friLater[0]!.chunk.fromMs).toBe(friTrace.chunk.toMs);
    const friRef = reference(config, 4, 17);
    const friMine = friRef.chunks
      .flatMap((c) => requestRows(c.requests))
      .filter((r) => r[2] === 17);
    const got = [
      ...requestRows(friTrace.chunk.requests),
      ...friLater.flatMap((m) => requestRows(m.chunk.requests)),
    ];
    expect(got).toEqual(friMine);
    // Days computed after the track (Monday, Tuesday) need no trace: their chunks carry analyst 17.
    const mon = ofType(after, 'chunk').filter((m) => m.chunk.day === 0);
    expect(mon.flatMap((m) => requestRows(m.chunk.requests)).every((r) => r[2] === 17)).toBe(true);
  });

  it('a second track cancels the first one’s pending traces', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config, [], TRACKED), calibration, FOCUS));
    t.runUntil(() =>
      ofType(t.out, 'chunk').some((m) => m.chunk.day === 4 && m.chunk.toMs >= simMs(4, 10)),
    );
    const before = t.out.length;
    t.send({ type: 'track', runId: 1, analyst: 17 });
    t.runAll(3);
    t.send({ type: 'track', runId: 1, analyst: 21 });
    t.runAll();
    const traces = ofType(t.out.slice(before), 'trace');
    expect(traces.every((m) => m.analyst === 21)).toBe(true);
    expect(traces.map((m) => m.day)).toEqual([2, 3, 4]);
  });
});

describe('engine host: focus and reset', { timeout: 60_000 }, () => {
  const config = smallConfig(2, 40);

  it('focus moves the playhead day to the front and cuts its chunk at the focus time', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    t.runAll(20);
    const before = t.out.length;
    const at = simMs(4, 9, 7);
    t.send({ type: 'focus', runId: 1, atMs: at });
    t.runAll();
    const after = t.out.slice(before);
    const days = after.map(messageDay).filter((d) => d !== null);
    const order: number[] = [];
    for (const d of days) if (order[order.length - 1] !== d) order.push(d);
    // Friday first, then wrap around: Monday, Tuesday, the rest of Wednesday, Thursday.
    expect(order).toEqual([4, 0, 1, 2, 3]);
    const cut = ofType(after, 'chunk').find((m) => m.chunk.toMs > at)!;
    expect(cut.chunk.toMs).toBe(simMs(4, 9, 8));
  });

  it('reset starts a new run: ready again, new runId, and old-run messages are ignored', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    t.runAll(60);
    const firstReady = ofType(t.out, 'ready')[0]!;
    expect(firstReady.runId).toBe(1);
    const before = t.out.length;
    t.send({ type: 'reset', runId: 2, focusMs: FOCUS });
    t.runAll(60);
    const ready = ofType(t.out.slice(before), 'ready')[0]!;
    expect(ready.runId).toBe(2);
    expect(ready.trackedAnalyst).toBe(firstReady.trackedAnalyst);
    // Stale messages from run 1 do nothing.
    t.send({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'set', atMs: simMs(2, 10), changes: { loadMultiplier: 2 } },
    });
    t.send({ type: 'focus', runId: 1, atMs: simMs(0, 9) });
    t.send({ type: 'track', runId: 1, analyst: 5 });
    t.runAll();
    const after = t.out.slice(before);
    expect(after.every((m) => m.runId === 2)).toBe(true);
    expect(after.every((m) => !('revision' in m) || m.revision === 0)).toBe(true);
    expect(ofType(after, 'trace')).toEqual([]);
    const order: number[] = [];
    for (const d of after.map(messageDay).filter((x) => x !== null)) {
      if (order[order.length - 1] !== d) order.push(d);
    }
    expect(order).toEqual([2, 3, 4, 0, 1]);
    // The reset run streams Wednesday again from its morning.
    expect(ofType(after, 'chunk')[0]!.chunk.fromMs).toBe(2 * DAY_MS);
  });

  it('posts an error and stops on a bad fork', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    t.runAll(5);
    t.send({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'set', atMs: simMs(2, 10), changes: { noSuchParam: 1 } as never },
    });
    t.runAll();
    const errors = ofType(t.out, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.runId).toBe(1);
    expect(errors[0]!.message).toMatch(/noSuchParam/);
  });
});
