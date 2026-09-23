import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import type { Patch } from '../engine/api.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_DAYS, simMs, type DayIndex } from '../engine/time.ts';
import type { WorkerToMain } from './protocol.ts';
import {
  applyMessages,
  canonical,
  createTestHost,
  emptyWeek,
  initMsg,
  messageDay,
  scenarioOf,
  smallConfig,
} from './testkit.ts';

const FOCUS = simMs(2, 10, 28);

function kinds(out: readonly WorkerToMain[]): string[] {
  return out.map((m) => m.type);
}

function chunksOf(out: readonly WorkerToMain[]) {
  return out.flatMap((m) => (m.type === 'chunk' ? [m] : []));
}

describe('engine host: init and streaming', () => {
  it('replies ready, then streams ordered chunks with progress, then dayComplete, focus day first', () => {
    const t = createTestHost();
    t.send(initMsg(scenarioOf(smallConfig(2)), calibration, FOCUS));
    expect(t.out[0]!.type).toBe('ready');
    const ready = t.out[0] as Extract<WorkerToMain, { type: 'ready' }>;
    expect(ready.runId).toBe(1);
    expect(ready.trackedAnalyst).toBe(3);
    expect(ready.sessionsByDay).toHaveLength(WEEK_DAYS);
    expect(ready.sessionsByDay[2]!.length).toBeGreaterThan(0);
    t.runAll();

    const days = t.out.map(messageDay).filter((d) => d !== null);
    // Focus day (Wednesday) first, then Thursday, Friday, Monday, Tuesday.
    const order: DayIndex[] = [];
    for (const d of days) if (order[order.length - 1] !== d) order.push(d);
    expect(order).toEqual([2, 3, 4, 0, 1]);

    // Every chunk is followed by a progress message that covers it.
    for (let i = 0; i < t.out.length; i++) {
      const m = t.out[i]!;
      if (m.type !== 'chunk') continue;
      const p = t.out[i + 1]!;
      expect(p.type).toBe('progress');
      if (p.type !== 'progress') continue;
      expect(p.computed.some((r) => r.fromMs <= m.chunk.fromMs && m.chunk.toMs <= r.toMs)).toBe(
        true,
      );
    }
    // Chunks of a day are contiguous from its midnight to the next.
    for (let d = 0; d < WEEK_DAYS; d++) {
      const cs = chunksOf(t.out).filter((m) => m.chunk.day === d);
      expect(cs[0]!.chunk.fromMs).toBe(d * DAY_MS);
      for (let i = 1; i < cs.length; i++) expect(cs[i]!.chunk.fromMs).toBe(cs[i - 1]!.chunk.toMs);
      expect(cs[cs.length - 1]!.chunk.toMs).toBe((d + 1) * DAY_MS);
      // The night is one chunk each side of the shift.
      expect(cs[0]!.chunk.toMs).toBe(d * DAY_MS + 7 * HOUR_MS);
      expect(cs[cs.length - 1]!.chunk.fromMs).toBe(d * DAY_MS + 17 * HOUR_MS);
    }
    // The chunk reaching the focus time ends at the next minute.
    const focusChunk = chunksOf(t.out).find((m) => m.chunk.toMs > FOCUS)!;
    expect(focusChunk.chunk.toMs).toBe(FOCUS + MINUTE_MS);
    // One dayComplete per day, after its last chunk, with a rollup row per replica.
    const completes = t.out.flatMap((m) => (m.type === 'dayComplete' ? [m] : []));
    expect(completes.map((m) => m.day)).toEqual([2, 3, 4, 0, 1]);
    for (const c of completes) expect(c.rollup).toHaveLength(2);
    const last = t.out.findLast((m) => m.type === 'progress');
    expect(last?.type === 'progress' && last.computed).toEqual([
      { fromMs: 0, toMs: WEEK_DAYS * DAY_MS },
    ]);
    expect(t.out.every((m) => m.runId === 1)).toBe(true);
    expect(kinds(t.out).filter((k) => k === 'error')).toEqual([]);
  });

  it('is deterministic: two runs post identical messages', () => {
    const run = () => {
      const t = createTestHost();
      t.send(initMsg(scenarioOf(smallConfig(3)), calibration, FOCUS));
      t.runAll();
      const view = emptyWeek();
      applyMessages(view, t.out);
      return { view: canonical(view), n: t.out.length };
    };
    const a = run();
    const b = run();
    expect(b.n).toBe(a.n);
    expect(b.view).toEqual(a.view);
  });
});

export type { Patch };
