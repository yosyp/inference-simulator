// A fork gives the same main-thread data as a fresh run with the patch (00-build E11 done-when),
// and never resends data before the cut (protocol.ts cut rule).

import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import type { Patch, SimConfig } from '../engine/api.ts';
import { DAY_MS, simMs, type DayIndex, type SimMs } from '../engine/time.ts';
import type { WorkerToMain } from './protocol.ts';
import {
  applyMessages,
  canonical,
  createTestHost,
  cutView,
  emptyWeek,
  initMsg,
  scenarioOf,
  smallConfig,
  type TestHost,
} from './testkit.ts';

const FOCUS = simMs(2, 9, 30);

interface Fork {
  patch: Patch;
  /** Tasks to run before sending it; undefined runs to idle first. */
  after?: number;
}

function cutOf(config: SimConfig, atMs: SimMs): SimMs {
  return Math.floor(atMs / config.histBucketMs) * config.histBucketMs;
}

/**
 * Checks the stream as the main thread sees it: on each day every chunk starts exactly where the
 * still-valid data ends, so nothing is resent and nothing is skipped. A fork moves that point back
 * to its cut (and to the morning of later days if it lasts).
 */
function createStreamCheck() {
  const sentTo = Array.from({ length: 5 }, (_, d) => d * DAY_MS);
  let revision = 0;
  return {
    message(m: WorkerToMain) {
      if (m.type === 'error') throw new Error(m.message);
      if (m.type !== 'chunk') return;
      expect(m.revision).toBe(revision);
      expect(m.chunk.fromMs).toBe(sentTo[m.chunk.day]);
      sentTo[m.chunk.day] = m.chunk.toMs;
    },
    fork(rev: number, day: DayIndex, cutMs: SimMs, lasting: boolean) {
      revision = rev;
      sentTo[day] = Math.min(sentTo[day]!, cutMs);
      if (lasting) for (let d = day + 1; d < 5; d++) sentTo[d] = d * DAY_MS;
    },
  };
}

/** Runs the forks against one host; returns the main-thread view and the posted messages. */
function forked(config: SimConfig, forks: Fork[], focusMs = FOCUS) {
  const t = createTestHost();
  t.send(initMsg(scenarioOf(config), calibration, focusMs));
  const view = emptyWeek();
  const check = createStreamCheck();
  let seen = 0;
  const drain = () => {
    for (const m of t.out.slice(seen)) check.message(m);
    applyMessages(view, t.out.slice(seen));
    seen = t.out.length;
  };
  const posted: { revision: number; cutMs: SimMs; day: DayIndex; messages: WorkerToMain[] }[] = [];
  forks.forEach((f, i) => {
    if (f.after === undefined) t.runAll();
    else t.runAll(f.after);
    drain();
    const cutMs = cutOf(config, f.patch.atMs);
    const day = Math.floor(f.patch.atMs / DAY_MS) as DayIndex;
    const lasting = f.patch.kind === 'set';
    cutView(view, day, cutMs, lasting);
    check.fork(i + 1, day, cutMs, lasting);
    const before = t.out.length;
    t.send({ type: 'fork', runId: 1, revision: i + 1, patch: f.patch });
    t.runAll();
    posted.push({ revision: i + 1, cutMs, day, messages: t.out.slice(before) });
  });
  drain();
  return { view: canonical(view), posted, t };
}

function fresh(config: SimConfig, patches: Patch[], focusMs = FOCUS) {
  const t: TestHost = createTestHost();
  t.send(initMsg(scenarioOf(config, patches), calibration, focusMs));
  t.runAll();
  const view = emptyWeek();
  applyMessages(view, t.out);
  return canonical(view);
}

/** Days whose rollup the fork recomputed. */
function recomputedDays(messages: readonly WorkerToMain[]): number[] {
  return [...new Set(messages.flatMap((m) => (m.type === 'dayComplete' ? [m.day] : [])))].sort();
}

describe('engine host: forks', { timeout: 60_000 }, () => {
  const config = smallConfig(2, 60);
  const lasting: Patch = {
    kind: 'set',
    atMs: simMs(2, 10, 44, 30),
    changes: { loadMultiplier: 1.6, routingPolicy: 'leastOutstanding' },
  };
  const oneShot: Patch = {
    kind: 'event',
    atMs: simMs(2, 10, 44, 30),
    event: { type: 'extraRequest', analyst: 'tracked', promptTokens: 20_000, outputTokens: 200 },
  };

  it('a lasting fork equals a fresh run with the patch, and recomputes later days only', () => {
    const f = forked(config, [{ patch: lasting }]);
    expect(f.view).toEqual(fresh(config, [lasting]));
    expect(recomputedDays(f.posted[0]!.messages)).toEqual([2, 3, 4]);
    // The first chunk after the fork is one minute long.
    const first = f.posted[0]!.messages.find((m) => m.type === 'chunk');
    expect(first?.type === 'chunk' && first.chunk.toMs - first.chunk.fromMs).toBe(60_000);
  });

  it('a one-shot fork equals a fresh run with the patch, and recomputes its own day only', () => {
    const f = forked(config, [{ patch: oneShot }]);
    expect(f.view).toEqual(fresh(config, [oneShot]));
    expect(recomputedDays(f.posted[0]!.messages)).toEqual([2]);
  });

  it('a crash fork (E8) equals a fresh run with it', () => {
    const crash: Patch = {
      kind: 'event',
      atMs: simMs(2, 10, 5, 20),
      event: { type: 'crash', replica: 1 },
    };
    const f = forked(config, [{ patch: crash }]);
    expect(f.view).toEqual(fresh(config, [crash]));
    expect(recomputedDays(f.posted[0]!.messages)).toEqual([2]);
  });

  it('forks mid-stream, before and after the day reaches the cut, and on another day', () => {
    const early: Patch = {
      kind: 'set',
      atMs: simMs(2, 11, 0, 10),
      changes: { loadMultiplier: 1.3 },
    };
    const later: Patch = {
      kind: 'event',
      atMs: simMs(3, 9, 12),
      event: { type: 'loadSpike', multiplier: 2, durationMs: 600_000 },
    };
    const back: Patch = {
      kind: 'set',
      atMs: simMs(2, 10, 20),
      changes: { turnsPerSessionMean: 2 },
    };
    // The first fork lands while Wednesday is still before 11:00; the others after some progress.
    const f = forked(config, [
      { patch: early, after: 40 },
      { patch: later, after: 30 },
      { patch: back, after: 10 },
    ]);
    expect(f.view).toEqual(fresh(config, [early, later, back]));
  });

  it('patches at one instant apply in fork order, so the later fork wins', () => {
    const at = simMs(2, 10, 30);
    const a: Patch = { kind: 'set', atMs: at, changes: { loadMultiplier: 1.8 } };
    const b: Patch = { kind: 'set', atMs: at, changes: { loadMultiplier: 0.5 } };
    const f = forked(config, [{ patch: a }, { patch: b }]);
    expect(f.view).toEqual(fresh(config, [a, b]));
    expect(f.view).not.toEqual(fresh(config, [b, a]));
  });

  it('a fork under detail tracked (3 replicas) equals a fresh run too', () => {
    const c3 = smallConfig(3, 40);
    const f = forked(c3, [{ patch: lasting }]);
    expect(f.view).toEqual(fresh(c3, [lasting]));
  });

  it('ignores a fork whose revision is not newer', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(config), calibration, FOCUS));
    t.runAll(20);
    t.send({ type: 'fork', runId: 1, revision: 0, patch: lasting });
    t.runAll(5);
    expect(t.out.every((m) => !('revision' in m) || m.revision === 0)).toBe(true);
  });
});
