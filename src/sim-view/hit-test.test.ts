import { describe, expect, it } from 'vitest';
import { dotStyles } from '../ui/theme/encodings.ts';
import { createDrawScratch, drawScene } from './draw-scene.ts';
import {
  HIT_SLOP_PX,
  analystAt,
  clearHits,
  createHitBuffer,
  hitTest,
  pushHit,
} from './hit-test.ts';
import { createRecordingContext, dots, replica, scene, shapes } from './test-support.ts';

const SLOT = { widthPx: 1008, heightPx: 271, dpr: 2 };

describe('hit buffer', () => {
  it('finds the nearest dot within its radius plus slop', () => {
    const h = createHitBuffer(4);
    pushHit(h, 10, 10, 4, 101, 1);
    pushHit(h, 20, 10, 4, 102, 2);
    expect(analystAt(h, 11, 10)).toBe(101);
    expect(analystAt(h, 18, 11)).toBe(102);
    expect(analystAt(h, 10, 10 + 4 + HIT_SLOP_PX)).toBe(101);
    expect(analystAt(h, 10, 10 + 4 + HIT_SLOP_PX + 0.5)).toBeNull();
    expect(analystAt(h, 15, 30)).toBeNull();
  });

  it('prefers the dot drawn last when two are equally near', () => {
    const h = createHitBuffer();
    pushHit(h, 10, 10, 4, 1, 1);
    pushHit(h, 10, 10, 4, 2, 2);
    expect(hitTest(h, 10, 10)).toBe(1);
    expect(analystAt(h, 10, 10)).toBe(2);
  });

  it('grows past its capacity and clears without reallocating', () => {
    const h = createHitBuffer(2);
    for (let i = 0; i < 100; i++) pushHit(h, i * 10, 0, 3, i, i);
    expect(h.count).toBe(100);
    expect(analystAt(h, 990, 0)).toBe(99);
    const x = h.x;
    clearHits(h);
    expect(h.count).toBe(0);
    expect(analystAt(h, 990, 0)).toBeNull();
    pushHit(h, 1, 1, 3, 5, 5);
    expect(h.x).toBe(x);
  });
});

describe('drawScene hit recording', () => {
  function drawn(s = scene()) {
    const ctx = createRecordingContext();
    const hits = createHitBuffer();
    drawScene(ctx, s, SLOT, { hits, scratch: createDrawScratch() });
    return { ctx, hits };
  }

  it('records every drawn dot at the position it was drawn, with its analyst', () => {
    const s = scene({
      replicas: [0, 1, 2, 3].map((r) =>
        replica(r, {
          dots: [
            ...dots(3, 'queued', 100 * r),
            ...dots(4, 'decode', 100 * r + 10),
            ...dots(1, 'preempted', 100 * r + 50),
          ],
        }),
      ),
      router: { atRouter: dots(2, 'queued', 900), offeredPerS: 1 },
    });
    const { ctx, hits } = drawn(s);
    expect(hits.count).toBe(4 * 8 + 2);
    const strokes = shapes(ctx).filter(
      (d) => d.op === 'stroke' && Object.values(dotStyles).some((st) => st.radiusPx === d.r),
    );
    expect(strokes).toHaveLength(hits.count);
    for (let i = 0; i < hits.count; i++) {
      expect(strokes.some((d) => d.x === hits.x[i] && d.y === hits.y[i])).toBe(true);
    }
    // Clicking a dot finds its analyst: the second decode dot on replica 2 belongs to analyst 211.
    const all = s.replicas[2]!.dots;
    const k = all.findIndex((d) => d.analyst === 211);
    const i = [...Array(hits.count).keys()].find((j) => hits.request[j] === all[k]!.request)!;
    expect(analystAt(hits, hits.x[i]! + 1, hits.y[i]! - 1)).toBe(211);
    // Router dots are clickable too.
    expect([...hits.analyst.subarray(0, hits.count)]).toEqual(expect.arrayContaining([900, 901]));
  });

  it('misses between lanes and on empty space', () => {
    const { hits } = drawn(scene({ replicas: [replica(0, { dots: dots(3, 'decode') })] }));
    expect(analystAt(hits, 2, 2)).toBeNull();
    expect(analystAt(hits, 900, 250)).toBeNull();
  });

  it('records nothing in aggregate or High-side mode', () => {
    const withDots = { replicas: [replica(0, { dots: dots(3, 'decode') })] };
    expect(drawn(scene({ ...withDots, detail: 'aggregate' })).hits.count).toBe(0);
    expect(drawn(scene({ ...withDots, mode: 'highSide' })).hits.count).toBe(0);
  });

  it('is cleared at the start of each frame', () => {
    const ctx = createRecordingContext();
    const hits = createHitBuffer();
    const scratch = createDrawScratch();
    drawScene(ctx, scene({ replicas: [replica(0, { dots: dots(5, 'decode') })] }), SLOT, {
      hits,
      scratch,
    });
    drawScene(ctx, scene({ replicas: [replica(0, { dots: dots(2, 'decode') })] }), SLOT, {
      hits,
      scratch,
    });
    expect(hits.count).toBe(2);
  });
});
