// Frame cost at the 00-build U3 budget: 8 replicas and about 1,000 dots, target ≤ 4 ms per frame.
// Node has no canvas, so this times drawScene's own work against a no-op context (the part that
// runs on the main thread in every browser), plus the recording context for reference. Real-browser
// numbers, raster included, are in the handoff note. The bound is loose so a busy machine doesn't
// flake; the printed table is the report.

import { describe, expect, it } from 'vitest';
import type { SceneState } from '../playback/types.ts';
import { createDrawScratch, drawScene } from './draw-scene.ts';
import { createHitBuffer } from './hit-test.ts';
import type { Ctx } from './paint.ts';
import {
  createNullContext,
  createRecordingContext,
  dots,
  replica,
  scene,
  turn,
} from './test-support.ts';

const VIEWPORT = { widthPx: 1008, heightPx: 271, dpr: 2 };

function busyScene(): SceneState {
  return scene({
    replicas: [...Array(8).keys()].map((r) =>
      replica(r, {
        kvUsedFrac: 0.9,
        running: 60,
        waiting: 65,
        dots: [
          ...dots(15, 'prefill'),
          ...dots(45, 'decode', 40, r === 3),
          ...dots(5, 'preempted'),
          ...dots(60, 'queued'),
        ],
      }),
    ),
    router: { atRouter: dots(4, 'queued'), offeredPerS: 30 },
    tracked: {
      analyst: 40,
      requests: [
        turn({ turn: 1, replica: 1 }),
        turn({ turn: 2, replica: 3, moved: true, ttftMs: 2400 }),
      ],
    },
  });
}

function time(ctx: Ctx, s: SceneState, runs = 300) {
  const hits = createHitBuffer();
  const scratch = createDrawScratch();
  const frame = (i: number) =>
    drawScene(ctx, { ...s, atMs: s.atMs + i * 16 }, VIEWPORT, { hits, scratch });
  for (let i = 0; i < 50; i++) frame(i);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    if ('reset' in ctx) (ctx as { reset(): void }).reset();
    const t0 = performance.now();
    frame(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(runs / 2)]!,
    p95Ms: samples[Math.floor(runs * 0.95)]!,
    hits: hits.count,
    scratch,
  };
}

describe('drawScene frame cost', () => {
  it('draws 8 replicas and ~1,000 dots well within 4 ms, reusing its scratch', () => {
    const s = busyScene();
    const total = s.replicas.reduce((a, r) => a + r.dots.length, 0) + s.router.atRouter.length;
    const nul = createNullContext();
    const bare = time(nul, s);
    const rec = time(createRecordingContext(), s, 60);
    console.info(
      [
        `\ndrawScene, 8 replicas, ${total} dots (median / p95 of runs)`,
        `  no-op context:      ${bare.medianMs.toFixed(3)} ms / ${bare.p95Ms.toFixed(3)} ms`,
        `  recording context:  ${rec.medianMs.toFixed(3)} ms / ${rec.p95Ms.toFixed(3)} ms`,
        `  context calls per frame: ${Math.round(nul.calls / 350)}\n`,
      ].join('\n'),
    );
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(bare.hits).toBe(total);
    expect(bare.medianMs).toBeLessThan(4);

    // The dot scratch is sized once and then reused frame after frame.
    const x = bare.scratch.dots.x;
    const layout = bare.scratch.layout;
    drawScene(nul, s, VIEWPORT, { scratch: bare.scratch });
    expect(bare.scratch.dots.x).toBe(x);
    expect(bare.scratch.layout).toBe(layout);
  });
});
