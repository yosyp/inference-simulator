import { describe, expect, it } from 'vitest';
import { calibration } from '../data/calibration.ts';
import { DAY_MS, simMs } from '../engine/time.ts';
import { FIXTURE_TRACKED_ANALYST } from '../fixtures/chunks.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { toWorkerScenario } from '../scenarios/schema.ts';
import type { MainToWorker, WorkerToMain } from '../worker/protocol.ts';
import { createFakeTransport } from './fake-transport.ts';
import { createTaskQueue } from './manual.ts';

function setup(replicas = 1) {
  const queue = createTaskQueue();
  const fake = createFakeTransport({ schedule: queue.schedule, chunkMs: 60 * 60_000 });
  const got: WorkerToMain[] = [];
  fake.onMessage((m) => got.push(m));
  const scenario = fixtureScenarios().find((s) => s.sim.replicas === replicas)!;
  const init: MainToWorker = {
    type: 'init',
    runId: 1,
    scenario: toWorkerScenario(scenario),
    calibration,
    focusMs: simMs(2, 10),
  };
  const of = <T extends WorkerToMain['type']>(type: T) =>
    got.filter((m): m is Extract<WorkerToMain, { type: T }> => m.type === type);
  return { queue, fake, got, init, of };
}

describe('fake transport', () => {
  it('answers init with ready, then streams the focused day first, in order', () => {
    const { queue, fake, init, got, of } = setup();
    fake.postMessage(init);
    expect(got).toEqual([]); // replies are asynchronous
    queue.runAll(4 * 24 + 10);
    expect(got[0]).toMatchObject({
      type: 'ready',
      runId: 1,
      trackedAnalyst: FIXTURE_TRACKED_ANALYST,
    });
    const chunks = of('chunk');
    expect(chunks.slice(0, 24).map((m) => m.chunk.fromMs)).toEqual(
      [...Array(24).keys()].map((h) => simMs(2, h)),
    );
    expect(chunks[24]!.chunk.fromMs).toBe(simMs(3, 0));
    expect(of('dayComplete')[0]).toMatchObject({ day: 2, revision: 0 });
    expect(of('dayComplete')[0]!.rollup).toHaveLength(1);
    const [first] = of('progress').at(-1)!.computed;
    expect(first!.fromMs).toBe(simMs(2, 0));
    expect(first!.toMs).toBeGreaterThan(simMs(3, 0));
  });

  it('computes the rest of the week after the focused day, then earlier days', () => {
    const { queue, fake, init, of } = setup();
    fake.postMessage(init);
    queue.runAll();
    expect(of('dayComplete').map((m) => m.day)).toEqual([2, 3, 4, 0, 1]);
    expect(of('progress').at(-1)!.computed).toEqual([{ fromMs: 0, toMs: 5 * DAY_MS }]);
  });

  it('moves a focused day to the front', () => {
    const { queue, fake, init, of } = setup();
    fake.postMessage(init);
    queue.runAll(10);
    fake.postMessage({ type: 'focus', runId: 1, atMs: simMs(0, 9) });
    queue.runAll();
    expect(of('dayComplete').map((m) => m.day)).toEqual([0, 2, 3, 4, 1]);
  });

  it('ignores messages from another run', () => {
    const { queue, fake, init, of } = setup();
    fake.postMessage(init);
    queue.runAll(10);
    fake.postMessage({ type: 'focus', runId: 9, atMs: simMs(0, 9) });
    fake.postMessage({ type: 'requestDetail', runId: 9, requestTag: 1, fromMs: 0, toMs: 60_000 });
    queue.runAll();
    expect(of('dayComplete').map((m) => m.day)).toEqual([2, 3, 4, 0, 1]);
    expect(of('detail')).toEqual([]);
  });

  it('streams from the cut under the new revision; a one-shot fork recomputes only its day', () => {
    const { queue, fake, init, got, of } = setup();
    fake.postMessage(init);
    queue.runAll();
    got.length = 0;
    const atMs = simMs(2, 10, 30, 30);
    fake.postMessage({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'event', atMs, event: { type: 'crash', replica: 0 } },
    });
    queue.runAll();
    const chunks = of('chunk');
    expect(chunks.every((m) => m.revision === 1)).toBe(true);
    expect(chunks[0]!.chunk.fromMs).toBe(simMs(2, 10, 30));
    expect(chunks.at(-1)!.chunk.toMs).toBe(3 * DAY_MS);
    expect(of('dayComplete').map((m) => m.day)).toEqual([2]);
    // The crash shows in the recomputed data.
    expect(chunks.some((m) => m.chunk.replicaEvents.length > 0)).toBe(true);
  });

  it('recomputes later days after a lasting fork', () => {
    const { queue, fake, init, got, of } = setup();
    fake.postMessage(init);
    queue.runAll();
    got.length = 0;
    fake.postMessage({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'set', atMs: simMs(2, 10), changes: { loadMultiplier: 2 } },
    });
    fake.postMessage({
      type: 'fork',
      runId: 1,
      revision: 1,
      patch: { kind: 'set', atMs: simMs(1, 10), changes: {} },
    });
    queue.runAll();
    expect(of('dayComplete').map((m) => m.day)).toEqual([2, 3, 4]);
  });

  it('answers track with a trace per computed day, relabelled to the analyst', () => {
    const { queue, fake, init, of } = setup();
    fake.postMessage(init);
    queue.runAll(30);
    fake.postMessage({ type: 'track', runId: 1, analyst: 42 });
    queue.runUntil(() => of('trace').length > 0);
    const traces = of('trace');
    expect(traces.map((m) => m.day)).toEqual([2]);
    expect(traces[0]!.chunk.requests.count).toBeGreaterThan(0);
    expect([...traces[0]!.chunk.requests.analyst].every((a) => a === 42)).toBe(true);
    // Later chunks carry the new analyst too.
    queue.runAll(40);
    const last = of('chunk').at(-1)!.chunk;
    expect(last.requests.count === 0 || last.requests.analyst[0] === 42).toBe(true);
  });

  it('answers requestDetail with an all-scope chunk for the window', () => {
    const { queue, fake, init, of } = setup();
    fake.postMessage(init);
    queue.runAll(2);
    fake.postMessage({
      type: 'requestDetail',
      runId: 1,
      requestTag: 7,
      fromMs: simMs(2, 10),
      toMs: simMs(2, 10, 10),
    });
    queue.runAll(6);
    const [d] = of('detail');
    expect(d).toMatchObject({ requestTag: 7, revision: 0 });
    expect(d!.chunk.requests.scope).toBe('all');
    expect([d!.chunk.fromMs, d!.chunk.toMs]).toEqual([simMs(2, 10), simMs(2, 10, 10)]);
  });

  it('starts a new run on reset', () => {
    const { queue, fake, init, got, of } = setup();
    fake.postMessage(init);
    queue.runAll(30);
    got.length = 0;
    fake.postMessage({ type: 'reset', runId: 2, focusMs: simMs(0, 9) });
    queue.runUntil(() => of('chunk').some((m) => m.runId === 2));
    const run2 = got.filter((m) => m.runId === 2);
    expect(run2[0]).toMatchObject({ type: 'ready', runId: 2 });
    expect(run2[1]).toMatchObject({ type: 'chunk', revision: 0 });
    expect(run2[1]!.type === 'chunk' && run2[1]!.chunk.fromMs).toBe(0);
    // Nothing from run 1 follows the reset once the in-flight messages are through.
    queue.runAll(50);
    const lastRun1 = got.findLastIndex((m) => m.runId === 1);
    expect(lastRun1).toBeLessThan(got.indexOf(run2[0]!));
  });

  it('clones what it is sent, like postMessage', () => {
    const { fake, init } = setup();
    const bad = { ...init, scenario: { ...init.scenario, extra: () => 1 } } as MainToWorker;
    expect(() => fake.postMessage(bad)).toThrow();
  });

  it('goes quiet once terminated', () => {
    const { queue, fake, init, got } = setup();
    fake.postMessage(init);
    fake.terminate();
    queue.runAll();
    expect(got).toEqual([]);
    expect(fake.terminated).toBe(true);
  });
});
