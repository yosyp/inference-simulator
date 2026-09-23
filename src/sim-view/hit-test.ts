// Click-to-track (05 §7): drawScene records where it drew each dot into a reusable HitBuffer, and a
// click finds the nearest dot within its radius plus a little slop. Typed arrays, grown by doubling,
// so recording costs no allocation per dot.

import type { AnalystId } from '../engine/api.ts';

export interface HitBuffer {
  count: number;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  analyst: Float64Array;
  request: Float64Array;
}

/** Extra reach around a dot, in CSS px, so small dots are easy to click. */
export const HIT_SLOP_PX = 3;

export function createHitBuffer(capacity = 256): HitBuffer {
  return {
    count: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    r: new Float32Array(capacity),
    analyst: new Float64Array(capacity),
    request: new Float64Array(capacity),
  };
}

export function clearHits(h: HitBuffer): void {
  h.count = 0;
}

function grow(h: HitBuffer): void {
  const cap = h.x.length * 2;
  const x = new Float32Array(cap);
  const y = new Float32Array(cap);
  const r = new Float32Array(cap);
  const analyst = new Float64Array(cap);
  const request = new Float64Array(cap);
  x.set(h.x);
  y.set(h.y);
  r.set(h.r);
  analyst.set(h.analyst);
  request.set(h.request);
  h.x = x;
  h.y = y;
  h.r = r;
  h.analyst = analyst;
  h.request = request;
}

export function pushHit(
  h: HitBuffer,
  x: number,
  y: number,
  r: number,
  analyst: AnalystId,
  request: number,
): void {
  if (h.count === h.x.length) grow(h);
  const i = h.count++;
  h.x[i] = x;
  h.y[i] = y;
  h.r[i] = r;
  h.analyst[i] = analyst;
  h.request[i] = request;
}

/**
 * Index of the dot nearest (px, py) whose radius plus slop reaches it, or -1. Later dots win ties,
 * since they are drawn on top.
 */
export function hitTest(h: HitBuffer, px: number, py: number, slopPx = HIT_SLOP_PX): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < h.count; i++) {
    const dx = px - h.x[i]!;
    const dy = py - h.y[i]!;
    const d = Math.sqrt(dx * dx + dy * dy);
    const reach = h.r[i]! + slopPx;
    if (d <= reach && d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** The analyst whose dot is under (px, py), or null. */
export function analystAt(
  h: HitBuffer,
  px: number,
  py: number,
  slopPx = HIT_SLOP_PX,
): AnalystId | null {
  const i = hitTest(h, px, py, slopPx);
  return i < 0 ? null : h.analyst[i]!;
}
