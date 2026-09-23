import { describe, expect, it } from 'vitest';
import { HISTOGRAM_SPECS, quantile, addSparseCellInto } from '../../engine/histogram.ts';
import {
  FLEET_SERIES,
  REPLICA_STATE,
  REQUEST_STATE,
  allocRequestBlock,
  replicaSeries,
  type ResultChunk,
} from '../../engine/results.ts';
import { MINUTE_MS, simMs } from '../../engine/time.ts';
import {
  FIXTURE_BUCKET_MS,
  FIXTURE_TRACKED_ANALYST,
  makeFixtureChunk,
  makeFixtureChunks,
} from '../../fixtures/chunks.ts';
import { replicaPhase } from '../../fixtures/synthetic.ts';
import type { SceneState } from '../types.ts';
import { createResultsStore } from './index.ts';
import { makeWorld, referenceDots, worldChunk, type RefDot } from './test-support.ts';

const live = { mode: 'live', detail: 'dots', trackedAnalyst: null } as const;

/** Every dot in a scene, as the reference reports them. */
function sceneDots(scene: SceneState): RefDot[] {
  const code = {
    queued: -1,
    prefill: REQUEST_STATE.prefill,
    decode: REQUEST_STATE.decode,
    preempted: REQUEST_STATE.preempted,
  };
  const out: RefDot[] = [];
  for (const d of scene.router.atRouter) {
    out.push({
      request: d.request,
      state: REQUEST_STATE.atRouter,
      replica: -1,
      progress: d.progress,
    });
  }
  for (const r of scene.replicas) {
    for (const d of r.dots) {
      out.push({
        request: d.request,
        state: code[d.state],
        replica: r.replica,
        progress: d.progress,
      });
    }
  }
  return out.sort((a, b) => a.request - b.request);
}

/** The reference with waiting shown as queued, the only distinction the canvas draws. */
function asDrawn(ref: RefDot[]): RefDot[] {
  return ref.map((d) => (d.state === REQUEST_STATE.waiting ? { ...d, state: -1 } : d));
}

function expectDots(scene: SceneState, ref: RefDot[]) {
  const got = sceneDots(scene);
  const want = asDrawn(ref);
  expect(got.map((d) => [d.request, d.state, d.replica])).toEqual(
    want.map((d) => [d.request, d.state, d.replica]),
  );
  got.forEach((d, i) => expect(d.progress).toBeCloseTo(want[i]!.progress, 9));
}

describe('sceneAt dots from scope-all chunks', () => {
  const replicas = 4;
  const from = simMs(2, 9);
  const to = simMs(2, 10);
  // 5-minute chunks; requests wait up to 40 s, prefill up to 15 s, and decode up to 25 s.
  const chunkMs = 5 * MINUTE_MS;
  const ranges: [number, number][] = [];
  for (let t = from; t < to; t += chunkMs) ranges.push([t, t + chunkMs]);
  // Sample times include chunk boundaries and the instants either side of them.
  const times: number[] = [];
  for (let i = 0; i < 60; i++)
    times.push(from + 1 + Math.floor((((i * 7919) % 997) / 997) * (to - from - 2)));
  for (const [a] of ranges.slice(1)) times.push(a - 1, a, a + 1);

  for (const terminalTransitions of [false, true]) {
    const world = makeWorld({
      fromMs: from - 2 * MINUTE_MS,
      toMs: to,
      replicas,
      perSecond: 6,
      terminalTransitions,
    });
    const chunks = [
      worldChunk(world, replicas, from - 2 * MINUTE_MS, from),
      ...ranges.map(([a, b]) => worldChunk(world, replicas, a, b)),
    ];

    it(`matches the brute-force reference at arbitrary times (terminal transitions: ${terminalTransitions})`, () => {
      const s = createResultsStore(replicas);
      for (const c of chunks) s.addChunk(c);
      let total = 0;
      for (const t of times) {
        const scene = s.index.sceneAt(t, live);
        expect(scene.detail).toBe('dots');
        const ref = referenceDots(world, t, to);
        expectDots(scene, ref);
        total += ref.length;
      }
      expect(total).toBeGreaterThan(times.length * 20);
    });

    it(`survives a cut and a re-stream from the cut (terminal transitions: ${terminalTransitions})`, () => {
      const s = createResultsStore(replicas);
      for (const c of chunks) s.addChunk(c);
      const cut = simMs(2, 9, 23); // Inside the 09:20-09:25 chunk.
      s.cut(2, cut, false);
      for (const t of times.filter((x) => x < cut))
        expectDots(s.index.sceneAt(t, live), referenceDots(world, t, cut));
      expect(s.index.sceneAt(cut, live).detail).toBe('aggregate');
      // The worker re-streams from the cut: first to the next chunk boundary, then as before.
      s.addChunk(worldChunk(world, replicas, cut, simMs(2, 9, 25)));
      for (const [a, b] of ranges.filter(([a]) => a >= simMs(2, 9, 25)))
        s.addChunk(worldChunk(world, replicas, a, b));
      for (const t of times) expectDots(s.index.sceneAt(t, live), referenceDots(world, t, to));
    });

    it(`re-applies a cut after a straddling chunk lands (terminal transitions: ${terminalTransitions})`, () => {
      const s = createResultsStore(replicas);
      const cut = simMs(2, 9, 23);
      const straddling = chunks.find((c) => c.fromMs === simMs(2, 9, 20))!;
      for (const c of chunks) if (c.fromMs < straddling.fromMs) s.addChunk(c);
      s.cut(2, cut, false);
      s.addChunk(straddling);
      s.cut(2, cut, false);
      s.cut(2, cut, false);
      for (const t of times.filter((x) => x < cut))
        expectDots(s.index.sceneAt(t, live), referenceDots(world, t, cut));
      s.addChunk(worldChunk(world, replicas, cut, simMs(2, 9, 25)));
      for (const [a, b] of ranges.filter(([a]) => a >= simMs(2, 9, 25)))
        s.addChunk(worldChunk(world, replicas, a, b));
      for (const t of times) expectDots(s.index.sceneAt(t, live), referenceDots(world, t, to));
    });
  }

  it('shows dots only in live dot mode', () => {
    const world = makeWorld({
      fromMs: from,
      toMs: to,
      replicas,
      perSecond: 6,
      terminalTransitions: false,
    });
    const s = createResultsStore(replicas);
    for (const [a, b] of ranges) s.addChunk(worldChunk(world, replicas, a, b));
    const t = simMs(2, 9, 30);
    for (const o of [
      { ...live, mode: 'highSide' as const },
      { ...live, detail: 'aggregate' as const },
    ]) {
      const scene = s.index.sceneAt(t, o);
      expect(scene.detail).toBe('aggregate');
      expect(scene.router.atRouter).toEqual([]);
      expect(scene.replicas.every((r) => r.dots.length === 0)).toBe(true);
    }
  });

  it('flags the tracked analyst on dots', () => {
    const world = makeWorld({
      fromMs: from,
      toMs: to,
      replicas,
      perSecond: 6,
      terminalTransitions: false,
    });
    const s = createResultsStore(replicas);
    for (const [a, b] of ranges) s.addChunk(worldChunk(world, replicas, a, b));
    const scene = s.index.sceneAt(simMs(2, 9, 30), { ...live, trackedAnalyst: 5 });
    const dots = [...scene.router.atRouter, ...scene.replicas.flatMap((r) => r.dots)];
    expect(dots.some((d) => d.tracked)).toBe(true);
    for (const d of dots) expect(d.tracked).toBe(d.analyst === 5);
  });
});

describe('sceneAt dots from detail windows', () => {
  const replicas = 3;
  const opts = { replicas };
  const world = makeWorld({
    fromMs: simMs(3, 9),
    toMs: simMs(3, 11),
    replicas,
    perSecond: 4,
    terminalTransitions: false,
  });
  const detailFrom = simMs(3, 10, 2);
  const detailTo = simMs(3, 10, 7);

  function withDetail() {
    const s = createResultsStore(replicas);
    for (const c of makeFixtureChunks(opts, simMs(3, 9), simMs(3, 11))) s.addChunk(c);
    // Requests in flight at the window's start come with their history.
    s.addDetail(worldChunk(world, replicas, detailFrom, detailTo, simMs(3, 9)));
    return s;
  }

  it('draws dots only inside the window, matching the reference there', () => {
    const s = withDetail();
    expect(s.index.sceneAt(detailFrom - 1, live).detail).toBe('aggregate');
    expect(s.index.sceneAt(detailTo, live).detail).toBe('aggregate');
    for (let t = detailFrom; t < detailTo; t += 7_919) {
      const scene = s.index.sceneAt(t, live);
      expect(scene.detail).toBe('dots');
      expectDots(scene, referenceDots(world, t, detailTo));
    }
  });

  it('trims the window at a cut and drops it past the cut', () => {
    const s = withDetail();
    s.cut(3, simMs(3, 10, 5), false);
    expect(s.index.sceneAt(simMs(3, 10, 4), live).detail).toBe('dots');
    expect(s.index.sceneAt(simMs(3, 10, 5), live).detail).toBe('aggregate');
    s.cut(3, simMs(3, 10, 1), false);
    expect(s.index.sceneAt(simMs(3, 10, 3), live).detail).toBe('aggregate');
  });

  it('keeps a bounded number of detail windows', () => {
    const s = createResultsStore(replicas, { maxDetailChunks: 2 });
    for (const c of makeFixtureChunks(opts, simMs(3, 9), simMs(3, 11))) s.addChunk(c);
    for (const m of [0, 10, 20]) {
      s.addDetail(worldChunk(world, replicas, simMs(3, 9, m), simMs(3, 9, m + 5), simMs(3, 9)));
    }
    expect(s.index.sceneAt(simMs(3, 9, 2), live).detail).toBe('aggregate');
    expect(s.index.sceneAt(simMs(3, 9, 12), live).detail).toBe('dots');
    expect(s.index.sceneAt(simMs(3, 9, 22), live).detail).toBe('dots');
  });
});

describe('sceneAt and statusAt from fixture chunks', () => {
  const opts = { replicas: 8, crash: { replica: 3, atMs: simMs(2, 10, 30) } };
  const chunks = makeFixtureChunks(opts, simMs(2, 7), simMs(2, 17));
  const s = createResultsStore(8);
  for (const c of chunks) s.addChunk(c);

  function bucket(t: number): { c: ResultChunk; i: number } {
    const c = chunks.find((x) => x.fromMs <= t && t < x.toMs)!;
    return { c, i: Math.floor((t - c.scalars.startMs) / FIXTURE_BUCKET_MS) };
  }

  it('reads levels from the bucket containing t and rates over the last minute', () => {
    const t = simMs(2, 11, 7, 33);
    const status = s.index.statusAt(t);
    const { c, i } = bucket(t);
    const at = (m: 'kvUsedFrac' | 'running' | 'waiting', series: number) =>
      c.scalars.data[m][i * c.scalars.series + series]!;
    const minute = (m: 'decodeTokens' | 'busyMs' | 'offered', series: number) => {
      let sum = 0;
      for (let k = 0; k < 6; k++) {
        const b = bucket(t - k * FIXTURE_BUCKET_MS);
        sum += b.c.scalars.data[m][b.i * b.c.scalars.series + series]!;
      }
      return sum;
    };
    const r2 = status.replicas[2]!;
    expect(r2.kvUsedFrac).toBe(at('kvUsedFrac', replicaSeries(2)));
    expect(r2.running).toBe(at('running', replicaSeries(2)));
    expect(r2.waiting).toBe(at('waiting', replicaSeries(2)));
    expect(r2.decodeTokensPerS).toBeCloseTo(minute('decodeTokens', replicaSeries(2)) / 60, 6);
    expect(r2.nvidiaSmiUtil).toBeCloseTo(minute('busyMs', replicaSeries(2)) / 60_000, 6);
    expect(r2.computeUtil).toBeGreaterThan(0);
    expect(r2.computeUtil).toBeLessThan(1);
    expect(status.fleet.offeredPerS).toBeCloseTo(minute('offered', FLEET_SERIES) / 60, 6);
    expect(status.fleet.amplification).toBe(1);

    const h = chunks.find((x) => x.fromMs <= t && t < x.toMs)!.histograms;
    const hi = Math.floor((t - h.startMs) / h.bucketMs);
    const dense = new Uint32Array(HISTOGRAM_SPECS.ttft.bins);
    addSparseCellInto(dense, 0, h.data.ttft, hi * h.series + FLEET_SERIES);
    expect(status.fleet.ttftP99Ms).toBe(quantile(HISTOGRAM_SPECS.ttft, dense, 0, 0.99));
  });

  it('takes replica states and loading progress from replica events', () => {
    for (let t = simMs(2, 10, 29); t < simMs(2, 10, 35); t += 3_571) {
      const want = replicaPhase(opts, 3, t);
      const got = s.index.sceneAt(t, live).replicas[3]!;
      expect(got.state).toBe(REPLICA_STATE[want.phase]);
      if (want.progress === null) expect(got.phaseProgress).toBeNull();
      else expect(got.phaseProgress).toBeCloseTo(want.progress, 9);
      expect(s.index.statusAt(t).replicas[3]!.state).toBe(REPLICA_STATE[want.phase]);
    }
    expect(s.index.statusAt(simMs(2, 10, 29)).replicas[3]!.state).toBe(REPLICA_STATE.ready);
  });

  it('returns aggregate detail and no dots without scope-all data', () => {
    const scene = s.index.sceneAt(simMs(2, 10), live);
    expect(scene.detail).toBe('aggregate');
    expect(scene.replicas.every((r) => r.dots.length === 0)).toBe(true);
    expect(scene.replicas).toHaveLength(8);
  });

  it("lists the tracked analyst's requests with their state at t", () => {
    const t = simMs(2, 12, 3, 3);
    const scene = s.index.sceneAt(t, { ...live, trackedAnalyst: FIXTURE_TRACKED_ANALYST });
    const requests = scene.tracked!.requests;
    // Direct: the fixture's tracked records, one every 3 minutes from 07:00.
    const recs = chunks
      .flatMap((c) => Array.from({ length: c.requests.count }, (_, k) => ({ b: c.requests, k })))
      .filter(({ b, k }) => b.arriveMs[k]! <= t);
    expect(requests.map((r) => r.request)).toEqual(recs.map(({ b, k }) => b.id[k]!));
    for (const [j, { b, k }] of recs.entries()) {
      const r = requests[j]!;
      expect(r.turn).toBe(b.turn[k]);
      expect(r.moved).toBe(b.prevReplica[k]! >= 0 && b.prevReplica[k] !== b.replica[k]);
      const end = b.endMs[k]!;
      const ft = b.firstTokenMs[k]!;
      if (end <= t) expect(r.state).toBe('finished');
      else
        expect(r.state).toBe(ft <= t ? 'decode' : t >= b.arriveMs[k]! + 2 ? 'prefill' : 'queued');
      expect(r.ttftMs).toBe(ft <= t ? ft - b.arriveMs[k]! : null);
      expect(r.replica).toBe(t >= b.arriveMs[k]! + 1 || end <= t ? b.replica[k] : null);
    }
    // The 12:03 request is still in flight three seconds later.
    expect(requests.at(-1)!.state).toBe('decode');
    expect(s.index.sceneAt(t, live).tracked).toBeNull();
  });

  it('shows in-flight tracked requests even before their record exists', () => {
    const partial = createResultsStore(8);
    // Transitions without records, as when a request's record lands in a later chunk.
    const chunk = makeFixtureChunk(opts, simMs(2, 12), simMs(2, 12, 6));
    partial.addChunk({ ...chunk, requests: allocRequestBlock('tracked', 0) });
    const t = simMs(2, 12, 3, 3);
    const views = partial.index.sceneAt(t, { ...live, trackedAnalyst: FIXTURE_TRACKED_ANALYST })
      .tracked!.requests;
    expect(views.map((r) => r.request)).toEqual([chunk.requests.id[0], chunk.requests.id[1]]);
    const inFlight = views[1]!;
    expect(inFlight.state).toBe('decode');
    expect(inFlight.replica).toBe(chunk.requests.replica[1]);
    expect(inFlight.ttftMs).toBeCloseTo(chunk.requests.firstTokenMs[1]! - simMs(2, 12, 3), 9);
    expect(inFlight.turn).toBe(0);
    expect(inFlight.moved).toBe(false);
  });

  it('prefers a trace over main-chunk tracked records inside its range', () => {
    const t2 = createResultsStore(8);
    for (const c of chunks) t2.addChunk(c);
    const trace = makeFixtureChunk(opts, simMs(2, 7), simMs(2, 12));
    trace.requests.analyst.fill(42);
    trace.transitions.analyst.fill(42);
    t2.addTrace(2, trace);
    const at = simMs(2, 13);
    const old = t2.index.sceneAt(at, { ...live, trackedAnalyst: FIXTURE_TRACKED_ANALYST }).tracked!;
    const fresh = t2.index.sceneAt(at, { ...live, trackedAnalyst: 42 }).tracked!;
    // Analyst 7's records before 12:00 were replaced; analyst 42's exist only there.
    const firstAfterTrace = Math.floor(simMs(2, 12) / 180_000);
    expect(old.requests.every((r) => r.request >= firstAfterTrace)).toBe(true);
    expect(fresh.requests.length).toBe(100);
    expect(fresh.requests.length + old.requests.length).toBe(
      s.index.sceneAt(at, { ...live, trackedAnalyst: FIXTURE_TRACKED_ANALYST }).tracked!.requests
        .length,
    );
  });
});
