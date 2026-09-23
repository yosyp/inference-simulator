// Request dots (05 §7). Positions come from a column-major grid anchored at the queue/batch divider,
// so a block's length reads as its count. Drawing batches every dot of one state into one path
// (one fill and one stroke per state), and reuses typed-array scratch: no allocation per dot.

import type { DotState, DotView } from '../playback/types.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import { colors } from '../ui/theme/colors.ts';
import { dotStyles, trackedStyle } from '../ui/theme/encodings.ts';
import { pushHit, type HitBuffer } from './hit-test.ts';
import { DOT_PITCH_PX, MIN_DOT_PITCH_X_PX, type LaneLayout, type Rect } from './layout.ts';
import { dotPath, text, type Ctx } from './paint.ts';

/** Width kept free at a grid's far end for its "+N" label. */
const OVERFLOW_LABEL_W_PX = 26;

export interface Grid {
  /** The anchored edge, and the direction columns grow from it. */
  x0: number;
  dir: 1 | -1;
  /** The other end, where "+N" goes. */
  farX: number;
  colPitch: number;
  rows: number;
  /** Center y of the first row. */
  top: number;
  shown: number;
  overflow: number;
}

export function createGrid(): Grid {
  return { x0: 0, dir: 1, farX: 0, colPitch: DOT_PITCH_PX, rows: 1, top: 0, shown: 0, overflow: 0 };
}

/**
 * Fits n items into columns of `rows` across an area, squeezing the column pitch down to
 * MIN_DOT_PITCH_X_PX before the rest overflow into a "+N" label.
 */
export function fitGrid(
  g: Grid,
  n: number,
  area: Rect,
  rows: number,
  top: number,
  dir: 1 | -1,
): void {
  const r = Math.max(1, rows);
  g.rows = r;
  g.top = top;
  g.dir = dir;
  g.x0 = dir === 1 ? area.x : area.x + area.w;
  g.farX = dir === 1 ? area.x + area.w : area.x;
  const colsNeeded = Math.ceil(n / r);
  let pitch = DOT_PITCH_PX;
  if (colsNeeded * pitch > area.w) {
    pitch = Math.max(MIN_DOT_PITCH_X_PX, area.w / Math.max(1, colsNeeded));
  }
  g.colPitch = pitch;
  const colsFit = Math.max(0, Math.floor(area.w / pitch + 1e-6));
  if (colsNeeded <= colsFit) {
    g.shown = n;
    g.overflow = 0;
    return;
  }
  const cols = Math.max(0, colsFit - Math.ceil(OVERFLOW_LABEL_W_PX / pitch));
  g.shown = Math.min(n, cols * r);
  g.overflow = n - g.shown;
}

export function gridX(g: Grid, k: number): number {
  return g.x0 + g.dir * g.colPitch * (Math.floor(k / g.rows) + 0.5);
}

export function gridY(g: Grid, k: number): number {
  return g.top + (k % g.rows) * DOT_PITCH_PX;
}

export interface DotScratch {
  /** Per dot index in the current list: position, or NaN x when it is folded into "+N". */
  x: Float32Array;
  y: Float32Array;
  queue: Grid;
  batch: Grid;
}

export function createDotScratch(capacity = 512): DotScratch {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    queue: createGrid(),
    batch: createGrid(),
  };
}

function ensure(s: DotScratch, n: number): void {
  if (s.x.length >= n) return;
  let cap = s.x.length;
  while (cap < n) cap *= 2;
  s.x = new Float32Array(cap);
  s.y = new Float32Array(cap);
}

function isRunning(state: DotState): boolean {
  return state === 'prefill' || state === 'decode';
}

/**
 * Places a replica's dots: running (prefill, decode) in the batch, growing right from the divider;
 * preempted then queued in the queue, growing left, so the head of the queue sits by the batch
 * (vLLM puts preempted requests back at the front).
 */
export function placeLaneDots(s: DotScratch, dots: readonly DotView[], lane: LaneLayout): void {
  ensure(s, dots.length);
  let nRun = 0;
  let nPre = 0;
  for (let i = 0; i < dots.length; i++) {
    const st = dots[i]!.state;
    if (isRunning(st)) nRun++;
    else if (st === 'preempted') nPre++;
  }
  const nWait = dots.length - nRun;
  fitGrid(s.queue, nWait, lane.queue, lane.rows, lane.rowTop, -1);
  fitGrid(s.batch, nRun, lane.batch, lane.rows, lane.rowTop, 1);
  let kr = 0;
  let kp = 0;
  let kq = nPre;
  for (let i = 0; i < dots.length; i++) {
    const st = dots[i]!.state;
    const inBatch = isRunning(st);
    const g = inBatch ? s.batch : s.queue;
    const k = inBatch ? kr++ : st === 'preempted' ? kp++ : kq++;
    if (k < g.shown) {
      s.x[i] = gridX(g, k);
      s.y[i] = gridY(g, k);
    } else {
      s.x[i] = NaN;
    }
  }
}

/** Places dots waiting at the router in one grid growing right from area.x. */
export function placeRouterDots(
  s: DotScratch,
  dots: readonly DotView[],
  area: Rect,
  rows: number,
  top: number,
): void {
  ensure(s, dots.length);
  fitGrid(s.queue, dots.length, area, rows, top, 1);
  for (let i = 0; i < dots.length; i++) {
    if (i < s.queue.shown) {
      s.x[i] = gridX(s.queue, i);
      s.y[i] = gridY(s.queue, i);
    } else {
      s.x[i] = NaN;
    }
  }
}

const DRAW_ORDER: readonly DotState[] = ['queued', 'preempted', 'prefill', 'decode'];

/** Draws placed dots, one path per state, then the tracked analyst's halos; records hits. */
export function drawDots(
  ctx: Ctx,
  dots: readonly DotView[],
  s: DotScratch,
  hits: HitBuffer | undefined,
): void {
  for (const state of DRAW_ORDER) {
    const style = dotStyles[state];
    let any = false;
    ctx.beginPath();
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i]!;
      if (d.state !== state) continue;
      const x = s.x[i]!;
      if (Number.isNaN(x)) continue;
      const y = s.y[i]!;
      dotPath(ctx, style.shape, x, y, style.radiusPx);
      if (hits) pushHit(hits, x, y, style.radiusPx, d.analyst, d.request);
      any = true;
    }
    if (!any) continue;
    if (style.fill) {
      ctx.fillStyle = style.fill;
      ctx.fill();
    }
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidthPx;
    ctx.stroke();
  }

  let anyTracked = false;
  ctx.beginPath();
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i]!;
    const x = s.x[i]!;
    if (!d.tracked || Number.isNaN(x)) continue;
    const r = dotStyles[d.state].radiusPx + trackedStyle.haloGapPx + trackedStyle.haloWidthPx / 2;
    ctx.moveTo(x + r, s.y[i]!);
    ctx.arc(x, s.y[i]!, r, 0, Math.PI * 2);
    anyTracked = true;
  }
  if (anyTracked) {
    ctx.strokeStyle = trackedStyle.haloStroke;
    ctx.lineWidth = trackedStyle.haloWidthPx;
    ctx.stroke();
  }
}

/** "+N" at a grid's far end for dots that didn't fit. */
export function drawOverflow(ctx: Ctx, g: Grid): void {
  if (g.overflow <= 0) return;
  const midY = g.top + ((g.rows - 1) * DOT_PITCH_PX) / 2;
  text(ctx, `+${g.overflow}`, g.farX - g.dir * 2, midY, {
    font: canvasFonts.numeric,
    color: colors['ink-muted'],
    align: g.dir === 1 ? 'right' : 'left',
  });
}
