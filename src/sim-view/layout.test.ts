import { describe, expect, it } from 'vitest';
import { layout as layoutTokens } from '../ui/theme/layout.ts';
import {
  DOT_PITCH_PX,
  MIN_LANE_H_PX,
  computeLayout,
  laneAt,
  type Rect,
  type SceneLayout,
} from './layout.ts';

// The canvas slot at 1440×900: 70% of the width, minus nothing; 272 px tall less its 1 px border.
const SLOT = { widthPx: 1008, heightPx: layoutTokens.canvasHeightPx - 1, dpr: 1 };

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 1e-9 &&
    inner.y >= outer.y - 1e-9 &&
    inner.x + inner.w <= outer.x + outer.w + 1e-9 &&
    inner.y + inner.h <= outer.y + outer.h + 1e-9
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function expectSane(l: SceneLayout) {
  const canvas = { x: 0, y: 0, w: l.viewport.widthPx, h: l.viewport.heightPx };
  expect(inside(l.router, canvas)).toBe(true);
  for (const lane of l.lanes) {
    expect(inside(lane, canvas)).toBe(true);
    expect(lane.x).toBeGreaterThanOrEqual(l.links.x + l.links.w);
    // Interior parts stay inside the lane and in order: queue, batch, tank, numbers.
    for (const part of [lane.queue, lane.batch, lane.tank, lane.numbers]) {
      expect(inside(part, lane)).toBe(true);
    }
    expect(lane.queue.x + lane.queue.w).toBeLessThanOrEqual(lane.batch.x);
    expect(lane.batch.x + lane.batch.w).toBeLessThanOrEqual(lane.tank.x);
    expect(lane.tank.x + lane.tank.w).toBeLessThanOrEqual(lane.numbers.x);
    // Every dot row fits vertically.
    const top = lane.rowTop - DOT_PITCH_PX / 2;
    expect(top).toBeGreaterThanOrEqual(lane.y);
    expect(top + lane.rows * DOT_PITCH_PX).toBeLessThanOrEqual(lane.y + lane.h + 1e-9);
  }
  for (let i = 0; i < l.lanes.length; i++) {
    for (let j = i + 1; j < l.lanes.length; j++) {
      expect(overlaps(l.lanes[i]!, l.lanes[j]!)).toBe(false);
    }
  }
}

describe('computeLayout', () => {
  it.each([1, 2, 4, 8])('fits %i replicas in the 272 px slot as one stacked column', (n) => {
    const l = computeLayout(SLOT, n);
    expectSane(l);
    expect(l.columns).toBe(1);
    expect(l.lanes).toHaveLength(n);
    expect(l.lanes.map((x) => x.replica)).toEqual([...Array(n).keys()]);
    // Stacked top to bottom in replica order, all the same size.
    for (let i = 1; i < n; i++) expect(l.lanes[i]!.y).toBeGreaterThan(l.lanes[i - 1]!.y);
    const heights = new Set(l.lanes.map((x) => x.h));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(l.lanes[0]!.h).toBeGreaterThanOrEqual(MIN_LANE_H_PX);
  });

  it('gives each lane room for its numbers and at least two dot rows at 8 replicas', () => {
    const l = computeLayout(SLOT, 8);
    for (const lane of l.lanes) {
      expect(lane.rows).toBe(2);
      expect(lane.numberLines).toBe(2);
      expect(lane.captions).toBe(false);
      // About 60 dots a side before squeezing.
      expect(Math.floor(lane.batch.w / DOT_PITCH_PX) * lane.rows).toBeGreaterThanOrEqual(60);
    }
  });

  it('uses captions and three number lines on tall lanes', () => {
    for (const n of [1, 2]) {
      const lane = computeLayout(SLOT, n).lanes[0]!;
      expect(lane.captions).toBe(true);
      expect(lane.numberLines).toBe(3);
      expect(lane.rows).toBe(10);
    }
  });

  it('wraps into columns only when stacked lanes would be too short', () => {
    const l = computeLayout({ widthPx: 1000, heightPx: 150, dpr: 1 }, 8);
    expectSane(l);
    expect(l.columns).toBe(2);
    expect(l.lanes[0]!.h).toBeGreaterThanOrEqual(MIN_LANE_H_PX);
    expect(l.lanes[4]!.x).toBeGreaterThan(l.lanes[0]!.x + l.lanes[0]!.w);
  });

  it('keeps the router on the left and the links between it and the lanes', () => {
    const l = computeLayout(SLOT, 4);
    expect(l.router.x).toBeLessThan(l.links.x);
    expect(l.links.x).toBe(l.router.x + l.router.w);
    expect(l.router.h).toBeGreaterThan(200);
  });

  it('lays out in CSS pixels regardless of devicePixelRatio', () => {
    expect(computeLayout({ ...SLOT, dpr: 2 }, 8).lanes).toEqual(computeLayout(SLOT, 8).lanes);
  });

  it('degrades without throwing on empty or tiny viewports', () => {
    expect(computeLayout({ widthPx: 0, heightPx: 0, dpr: 1 }, 8).lanes).toHaveLength(8);
    expect(computeLayout(SLOT, 0).lanes).toHaveLength(0);
  });

  it('finds the lane under a point', () => {
    const l = computeLayout(SLOT, 4);
    const lane = l.lanes[2]!;
    expect(laneAt(l, lane.x + 5, lane.cy)).toBe(2);
    expect(laneAt(l, l.router.x + 5, lane.cy)).toBe(-1);
  });
});
