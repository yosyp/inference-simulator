import { describe, expect, it } from 'vitest';
import { REPLICA_STATE, type RollupRow } from '../../engine/results.ts';
import {
  DAY_MS,
  HOUR_MS,
  WEEK_MS,
  rollupDeliveryMs,
  simMs,
  type DayIndex,
} from '../../engine/time.ts';
import {
  FIXTURE_TRACKED_ANALYST,
  makeFixtureChunk,
  makeFixtureChunks,
} from '../../fixtures/chunks.ts';
import type { ResultsStore, TimeWindow } from '../types.ts';
import { createResultsStore } from './index.ts';

const opts = { replicas: 4, crash: { replica: 2, atMs: simMs(1, 10, 30) } };
const days: DayIndex[] = [0, 1, 2, 3];
const chunksByDay = days.map((d) => makeFixtureChunks(opts, simMs(d, 9), simMs(d, 12)));

function rows(day: DayIndex): RollupRow[] {
  return [0, 1, 2, 3].map((replica) => ({
    day,
    replica,
    requestsServed: 100 + replica,
    meanE2eMs: 900,
    meanNvidiaSmiUtil: 0.5,
    deliveredAtMs: rollupDeliveryMs(day),
  }));
}

function fullStore(): ResultsStore {
  const s = createResultsStore(opts.replicas);
  for (const d of days) {
    for (const c of chunksByDay[d]!) s.addChunk(c);
    s.addRollup(d, rows(d));
  }
  s.setComputed(days.map((d) => ({ fromMs: d * DAY_MS, toMs: (d + 1) * DAY_MS })));
  return s;
}

const fine = (d: DayIndex): TimeWindow => ({ fromMs: simMs(d, 9), toMs: simMs(d, 12) });
const series = (s: ResultsStore, d: DayIndex) =>
  s.index.scalarSeries('decodeTokens', 1, fine(d), 10_000);
const hist = (s: ResultsStore, d: DayIndex) =>
  s.index.quantileSeries('ttft', 0, fine(d), 10_000, [0.5]);
const trackedAt = (s: ResultsStore, t: number) =>
  s.index.sceneAt(t, { mode: 'live', detail: 'dots', trackedAnalyst: FIXTURE_TRACKED_ANALYST })
    .tracked!.requests;

describe('cut', () => {
  const before = fullStore();
  // 10:37 is a histogram-bucket boundary inside the 10:30-10:45 chunk.
  const cutMs = simMs(1, 10, 37);

  function expectDayIntact(s: ResultsStore, d: DayIndex) {
    expect(series(s, d).v).toEqual(series(before, d).v);
    expect(hist(s, d).counts).toEqual(hist(before, d).counts);
    expect(s.index.requestPoints(fine(d)).t).toEqual(before.index.requestPoints(fine(d)).t);
  }

  it('same day: trims buckets, records, transitions, and events at cutMs, keeping the rest', () => {
    const s = fullStore();
    const v0 = s.index.version;
    s.cut(1, cutMs, false);
    expect(s.index.version).toBeGreaterThan(v0);

    // Scalar buckets: the straddling chunk keeps its buckets before the cut.
    const a = series(s, 1);
    const b = series(before, 1);
    let kept = 0;
    for (let i = 0; i < a.t.length; i++) {
      if (a.t[i]! < cutMs) {
        expect(a.v[i]).toBe(b.v[i]);
        kept++;
      } else expect(a.v[i]).toBeNaN();
    }
    expect(kept).toBe((cutMs - simMs(1, 9)) / 10_000);

    // Histogram buckets.
    const h = hist(s, 1);
    const hb = hist(before, 1);
    for (let i = 0; i < h.t.length; i++) {
      if (h.t[i]! < cutMs) expect(h.counts[i]).toBe(hb.counts[i]);
      else expect(h.counts[i]).toBeNaN();
    }

    // Records ending at or after the cut are gone; earlier ones stay.
    const pts = s.index.requestPoints(fine(1));
    const all = before.index.requestPoints(fine(1));
    expect([...pts.t]).toEqual([...all.t].filter((t) => t < cutMs));
    expect(pts.t.length).toBeGreaterThan(0);

    // Transitions and records: the tracked analyst's 10:36 request (done in seconds) is the last.
    const tracked = trackedAt(s, simMs(1, 11));
    expect(tracked.at(-1)!.request).toBe(Math.floor(simMs(1, 10, 36) / 180_000));
    expect(tracked.at(-1)!.state).toBe('finished');
    expect(tracked.length).toBe(trackedAt(before, simMs(1, 10, 36, 30)).length);

    // Replica events: the crash's recovery at 10:33:05 is kept, so the replica is ready again.
    expect(s.index.statusAt(simMs(1, 10, 36)).replicas[2]!.state).toBe(REPLICA_STATE.ready);

    // Other days are untouched, including later ones.
    for (const d of [0, 2, 3] as const) expectDayIntact(s, d);

    // The day's rollup and computed range are gone until the worker resends them.
    expect(s.index.completedDays()).toEqual([0, 2, 3]);
    expect(s.index.rollup().map((r) => r.day)).not.toContain(1);
    expect(s.index.computed()).toEqual([
      { fromMs: 0, toMs: DAY_MS },
      { fromMs: DAY_MS, toMs: cutMs },
      { fromMs: 2 * DAY_MS, toMs: 3 * DAY_MS },
      { fromMs: 3 * DAY_MS, toMs: 4 * DAY_MS },
    ]);
  });

  it('drops replica events at or after cutMs', () => {
    const s = fullStore();
    s.cut(1, simMs(1, 10, 32), false);
    // Loading started at 10:31:10 and init at 10:31:35; ready at 10:33:05 was cut.
    const status = s.index.statusAt(simMs(1, 10, 40));
    expect(status.replicas[2]!.state).toBe(REPLICA_STATE.initializingEngine);
    // The phase's end is unknown until the worker re-streams it.
    expect(status.replicas[2]!.phaseProgress).toBe(0);
  });

  it('lasting: also drops every later day', () => {
    const s = fullStore();
    s.cut(1, cutMs, true);
    expectDayIntact(s, 0);
    for (const d of [2, 3] as const) {
      expect([...series(s, d).v].every(Number.isNaN)).toBe(true);
      expect([...hist(s, d).counts].every(Number.isNaN)).toBe(true);
      expect(s.index.requestPoints(fine(d)).t.length).toBe(0);
      expect(trackedAt(s, simMs(d, 11))).toEqual([]);
    }
    expect(s.index.completedDays()).toEqual([0]);
    expect(s.index.rollup()).toEqual(rows(0));
    expect(s.index.computed()).toEqual([
      { fromMs: 0, toMs: DAY_MS },
      { fromMs: DAY_MS, toMs: cutMs },
    ]);
  });

  it('restores the same results when the worker re-streams from the cut', () => {
    const s = fullStore();
    s.cut(1, cutMs, true);
    s.addChunk(makeFixtureChunk(opts, cutMs, simMs(1, 10, 45)));
    for (const c of chunksByDay[1]!.filter((c) => c.fromMs >= simMs(1, 10, 45))) s.addChunk(c);
    for (const d of [2, 3] as const) for (const c of chunksByDay[d]!) s.addChunk(c);
    for (const d of days) {
      expect(series(s, d).v).toEqual(series(before, d).v);
      expect(hist(s, d).counts).toEqual(hist(before, d).counts);
      expect(s.index.requestPoints(fine(d)).t).toEqual(before.index.requestPoints(fine(d)).t);
      expect(trackedAt(s, simMs(d, 11, 30))).toEqual(trackedAt(before, simMs(d, 11, 30)));
    }
    expect(s.index.statusAt(simMs(1, 10, 32))).toEqual(before.index.statusAt(simMs(1, 10, 32)));
  });

  it('cuts a trace like any other data', () => {
    const s = fullStore();
    s.addTrace(1, makeFixtureChunk(opts, simMs(1, 9), simMs(1, 12)));
    s.cut(1, cutMs, false);
    const pts = s.index.requestPoints(fine(1));
    expect(Math.max(...pts.t)).toBeLessThan(cutMs);
    s.cut(1, simMs(1, 8), false);
    expect(s.index.requestPoints(fine(1)).t.length).toBe(0);
  });

  it('drops later days’ traces, detail windows, and rollups when lasting', () => {
    const s = fullStore();
    s.addTrace(2, makeFixtureChunk(opts, simMs(2, 9), simMs(2, 12)));
    s.addDetail(makeFixtureChunk(opts, simMs(2, 10), simMs(2, 10, 5)));
    s.cut(1, cutMs, true);
    expect(trackedAt(s, simMs(2, 11))).toEqual([]);
    expect(s.index.requestPoints(fine(2)).t.length).toBe(0);
    expect(s.index.rollup().every((r) => r.day === 0)).toBe(true);
  });

  /** Everything a renderer can read for day d and its neighbours. */
  function snapshot(s: ResultsStore) {
    return days.map((d) => ({
      series: series(s, d).v,
      hist: hist(s, d).counts,
      p99: s.index.quantileSeries('e2e', 3, fine(d), 10_000, [0.99]).values[0],
      points: s.index.requestPoints(fine(d)),
      tracked: [10, 10.6, 11].map((h) => trackedAt(s, d * DAY_MS + h * HOUR_MS)),
      status: [10.5, 10.55, 10.62].map((h) => s.index.statusAt(d * DAY_MS + h * HOUR_MS)),
      rollup: s.index.rollup(),
      days: s.index.completedDays(),
      computed: s.index.computed(),
    }));
  }

  it('is idempotent', () => {
    for (const lasting of [false, true]) {
      const once = fullStore();
      once.cut(1, cutMs, lasting);
      const twice = fullStore();
      twice.cut(1, cutMs, lasting);
      twice.cut(1, cutMs, lasting);
      expect(snapshot(twice)).toEqual(snapshot(once));
    }
  });

  it('re-applied after a straddling chunk from before the fork lands, equals the cut on full data', () => {
    for (const lasting of [false, true]) {
      const want = fullStore();
      want.cut(1, cutMs, lasting);
      // The 10:30-10:45 chunk was still in flight when the fork cut Tuesday.
      const straddling = chunksByDay[1]!.find((c) => c.fromMs === simMs(1, 10, 30))!;
      const s = createResultsStore(opts.replicas);
      for (const d of days) {
        for (const c of chunksByDay[d]!) if (c !== straddling && c.fromMs < cutMs) s.addChunk(c);
        if (d !== 1) for (const c of chunksByDay[d]!) if (c.fromMs >= cutMs) s.addChunk(c);
        s.addRollup(d, rows(d));
      }
      s.setComputed(days.map((d) => ({ fromMs: d * DAY_MS, toMs: (d + 1) * DAY_MS })));
      s.cut(1, cutMs, lasting);
      s.addChunk(straddling);
      s.cut(1, cutMs, lasting);
      expect(snapshot(s)).toEqual(snapshot(want));
    }
  });
});

describe('store bookkeeping', () => {
  it('increments version on every write', () => {
    const s = createResultsStore(2);
    const chunk = makeFixtureChunk({ replicas: 2 }, simMs(0, 9), simMs(0, 9, 15));
    const writes: (() => void)[] = [
      () => s.addChunk(chunk),
      () => s.addDetail(chunk),
      () => s.addTrace(0, chunk),
      () => s.addRollup(0, []),
      () => s.setComputed([{ fromMs: 0, toMs: HOUR_MS }]),
      () => s.cut(0, simMs(0, 9, 5), false),
      () => s.reset(3),
    ];
    let v = s.index.version;
    for (const w of writes) {
      w();
      expect(s.index.version).toBeGreaterThan(v);
      v = s.index.version;
    }
    expect(s.index.replicas).toBe(3);
    expect(s.index.computed()).toEqual([]);
    expect(s.index.completedDays()).toEqual([]);
    expect([...s.index.scalarSeries('running', 0, fine(0), 10).v].every(Number.isNaN)).toBe(true);
  });

  it('lists rollups and completed days in day order, stable between writes', () => {
    const s = createResultsStore(4);
    s.addRollup(3, rows(3));
    s.addRollup(0, rows(0));
    expect(s.index.completedDays()).toEqual([0, 3]);
    expect(s.index.rollup()).toEqual([...rows(0), ...rows(3)]);
    expect(s.index.rollup()).toBe(s.index.rollup());
    s.setComputed([{ fromMs: 0, toMs: WEEK_MS }]);
    expect(s.index.computed()).toEqual([{ fromMs: 0, toMs: WEEK_MS }]);
  });

  it('rejects a chunk whose bucket width disagrees with earlier chunks', () => {
    const s = createResultsStore(1);
    const chunk = makeFixtureChunk({ replicas: 1 }, simMs(0, 9), simMs(0, 9, 15));
    s.addChunk(chunk);
    const other = makeFixtureChunk({ replicas: 1 }, simMs(0, 10), simMs(0, 10, 15));
    expect(() => s.addChunk({ ...other, scalars: { ...other.scalars, bucketMs: 5_000 } })).toThrow(
      /Bucket width/,
    );
  });
});
