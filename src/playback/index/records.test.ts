import { describe, expect, it } from 'vitest';
import { OUTCOME, allocRequestBlock, type ResultChunk } from '../../engine/results.ts';
import { MINUTE_MS, simMs } from '../../engine/time.ts';
import { makeFixtureChunk, makeFixtureChunks } from '../../fixtures/chunks.ts';
import { createResultsStore } from './index.ts';
import { makeWorld, worldChunk } from './test-support.ts';

const t0 = simMs(1, 9);

interface Rec {
  id: number;
  arrive: number;
  firstToken: number;
  end: number;
  tokens: number;
  outcome: number;
  replica: number;
  analyst: number;
}

/** A tracked-scope chunk for [09:00, 09:05) holding these records, deliberately out of order. */
function chunkWith(recs: Rec[]): ResultChunk {
  const base = makeFixtureChunk({ replicas: 2 }, t0, t0 + 5 * MINUTE_MS);
  const b = allocRequestBlock('tracked', recs.length);
  recs.forEach((r, k) => {
    b.id[k] = r.id;
    b.arriveMs[k] = r.arrive;
    b.firstTokenMs[k] = r.firstToken;
    b.endMs[k] = r.end;
    b.outputTokens[k] = r.tokens;
    b.outcome[k] = r.outcome;
    b.replica[k] = r.replica;
    b.analyst[k] = r.analyst;
  });
  return { ...base, requests: b };
}

const recs: Rec[] = [
  // Finished: TTFT 250, TPOT (10_250 - 250) / 99 per token after the first, E2E 10_250.
  {
    id: 1,
    arrive: t0 + 1_000,
    firstToken: t0 + 1_250,
    end: t0 + 11_250,
    tokens: 101,
    outcome: OUTCOME.finished,
    replica: 1,
    analyst: 3,
  },
  // Finished with one token: no TPOT.
  {
    id: 2,
    arrive: t0 + 500,
    firstToken: t0 + 900,
    end: t0 + 900,
    tokens: 1,
    outcome: OUTCOME.finished,
    replica: 0,
    analyst: 4,
  },
  // Timed out before a first token: no TTFT, TPOT, or E2E.
  {
    id: 3,
    arrive: t0 + 2_000,
    firstToken: NaN,
    end: t0 + 32_000,
    tokens: 0,
    outcome: OUTCOME.timedOut,
    replica: 0,
    analyst: 3,
  },
  // Failed mid-decode: a real TTFT, but no TPOT or E2E.
  {
    id: 4,
    arrive: t0 + 3_000,
    firstToken: t0 + 3_400,
    end: t0 + 5_000,
    tokens: 40,
    outcome: OUTCOME.failed,
    replica: 1,
    analyst: 5,
  },
  // Rejected at the router.
  {
    id: 5,
    arrive: t0 + 4_000,
    firstToken: NaN,
    end: t0 + 4_001,
    tokens: 0,
    outcome: OUTCOME.rejected,
    replica: -1,
    analyst: 6,
  },
];

describe('requestPoints', () => {
  const s = createResultsStore(2);
  s.addChunk(chunkWith(recs));

  it('computes TTFT, TPOT, and E2E per record, keyed and sorted by end time', () => {
    const p = s.index.requestPoints({ fromMs: t0, toMs: t0 + 5 * MINUTE_MS });
    expect([...p.t]).toEqual([t0 + 900, t0 + 4_001, t0 + 5_000, t0 + 11_250, t0 + 32_000]);
    const at = (end: number) => [...p.t].indexOf(end);

    const i1 = at(t0 + 11_250);
    expect(p.ttftMs[i1]).toBe(250);
    expect(p.tpotMs[i1]).toBeCloseTo(10_000 / 100, 12);
    expect(p.e2eMs[i1]).toBe(10_250);
    expect(p.replica[i1]).toBe(1);
    expect(p.analyst[i1]).toBe(3);

    const i2 = at(t0 + 900);
    expect(p.ttftMs[i2]).toBe(400);
    expect(p.tpotMs[i2]).toBeNaN();
    expect(p.e2eMs[i2]).toBe(400);

    const i3 = at(t0 + 32_000);
    expect(p.ttftMs[i3]).toBeNaN();
    expect(p.tpotMs[i3]).toBeNaN();
    expect(p.e2eMs[i3]).toBeNaN();

    const i4 = at(t0 + 5_000);
    expect(p.ttftMs[i4]).toBe(400);
    expect(p.tpotMs[i4]).toBeNaN();
    expect(p.e2eMs[i4]).toBeNaN();

    const i5 = at(t0 + 4_001);
    expect(p.replica[i5]).toBe(-1);
    expect(p.e2eMs[i5]).toBeNaN();
  });

  it('includes only requests finishing in the window', () => {
    const p = s.index.requestPoints({ fromMs: t0 + 900, toMs: t0 + 11_250 });
    expect([...p.t]).toEqual([t0 + 900, t0 + 4_001, t0 + 5_000]);
    expect(s.index.requestPoints({ fromMs: simMs(1, 20), toMs: simMs(1, 21) }).t.length).toBe(0);
  });

  it('matches a direct computation over fixture chunks across days', () => {
    const chunks = [
      ...makeFixtureChunks({ replicas: 3 }, simMs(0, 16), simMs(0, 17)),
      ...makeFixtureChunks({ replicas: 3 }, simMs(1, 7), simMs(1, 8)),
    ];
    const f = createResultsStore(3);
    for (const c of chunks) f.addChunk(c);
    const window = { fromMs: simMs(0, 16, 20), toMs: simMs(1, 7, 40) };
    const p = f.index.requestPoints(window);
    const want: [number, number, number, number][] = [];
    for (const c of chunks) {
      const r = c.requests;
      for (let k = 0; k < r.count; k++) {
        const end = r.endMs[k]!;
        if (end < window.fromMs || end >= window.toMs) continue;
        want.push([
          end,
          r.firstTokenMs[k]! - r.arriveMs[k]!,
          (end - r.firstTokenMs[k]!) / (r.outputTokens[k]! - 1),
          end - r.arriveMs[k]!,
        ]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    expect(want.length).toBeGreaterThan(20);
    expect([...p.t].map((t, i) => [t, p.ttftMs[i], p.tpotMs[i], p.e2eMs[i]])).toEqual(want);
  });

  it('prefers scope-all detail records over tracked ones, without double counting', () => {
    const replicas = 2;
    const world = makeWorld({
      fromMs: t0,
      toMs: t0 + 20 * MINUTE_MS,
      replicas,
      perSecond: 2,
      terminalTransitions: false,
    });
    const f = createResultsStore(replicas);
    for (const c of makeFixtureChunks({ replicas }, t0, t0 + 30 * MINUTE_MS)) f.addChunk(c);
    const tracked = f.index.requestPoints({ fromMs: t0, toMs: t0 + 30 * MINUTE_MS });
    f.addDetail(worldChunk(world, replicas, t0 + 5 * MINUTE_MS, t0 + 10 * MINUTE_MS));
    const p = f.index.requestPoints({ fromMs: t0, toMs: t0 + 30 * MINUTE_MS });
    const inWindow = (t: number) => t >= t0 + 5 * MINUTE_MS && t < t0 + 10 * MINUTE_MS;
    const detail = world
      .filter((r) => inWindow(r.endMs))
      .map((r) => r.endMs)
      .sort((a, b) => a - b);
    const outside = [...tracked.t].filter((t) => !inWindow(t));
    expect([...p.t]).toEqual([...outside, ...detail].sort((a, b) => a - b));
    expect(detail.length).toBeGreaterThan(100);
  });
});
