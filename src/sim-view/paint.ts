// Low-level canvas helpers shared by the scene painters. Nothing here allocates per call except
// the text helpers' measureText result.

import type { DotShape } from '../ui/theme/encodings.ts';
import type { Rect } from './layout.ts';

/** The part of CanvasRenderingContext2D the renderer uses; test-support.ts records exactly this. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'fillRect'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'arcTo'
  | 'rect'
  | 'quadraticCurveTo'
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
  | 'setLineDash'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
>;

const NO_DASH: number[] = [];

export function setDash(ctx: Ctx, dash: readonly number[]): void {
  ctx.setLineDash(dash.length === 0 ? NO_DASH : (dash as number[]));
}

/** A rounded-rectangle subpath, inset by `inset` on every side. */
export function roundRectPath(ctx: Ctx, r: Rect, radius: number, inset = 0): void {
  const x = r.x + inset;
  const y = r.y + inset;
  const w = Math.max(0, r.w - 2 * inset);
  const h = Math.max(0, r.h - 2 * inset);
  const rad = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Fills and outlines a rounded box. The stroke sits inside the rect, on whole pixels. */
export function box(
  ctx: Ctx,
  r: Rect,
  fill: string | null,
  stroke: string | null,
  lineWidth = 1,
  dash: readonly number[] = NO_DASH,
  radius = 3,
): void {
  if (fill) {
    ctx.beginPath();
    roundRectPath(ctx, r, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.beginPath();
    roundRectPath(ctx, r, radius, lineWidth / 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    setDash(ctx, dash);
    ctx.stroke();
    setDash(ctx, NO_DASH);
  }
}

/** Diagonal hatching clipped to a rounded rect. */
export function hatch(
  ctx: Ctx,
  r: Rect,
  color: string,
  spacingPx: number,
  widthPx: number,
  radius = 3,
): void {
  ctx.save();
  ctx.beginPath();
  roundRectPath(ctx, r, radius);
  ctx.clip();
  ctx.beginPath();
  for (let d = -r.h; d < r.w; d += spacingPx) {
    ctx.moveTo(r.x + d, r.y + r.h);
    ctx.lineTo(r.x + d + r.h, r.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx;
  ctx.stroke();
  ctx.restore();
}

/** Adds one dot's outline to the current path. */
export function dotPath(ctx: Ctx, shape: DotShape, x: number, y: number, r: number): void {
  if (shape === 'diamond') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** A filled arrowhead with its tip at (x, y), pointing along (dx, dy) (a unit vector). */
export function arrowHeadPath(
  ctx: Ctx,
  x: number,
  y: number,
  dx: number,
  dy: number,
  size: number,
): void {
  const bx = x - dx * size;
  const by = y - dy * size;
  const px = -dy * size * 0.55;
  const py = dx * size * 0.55;
  ctx.moveTo(x, y);
  ctx.lineTo(bx + px, by + py);
  ctx.lineTo(bx - px, by - py);
  ctx.closePath();
}

/** A ">" chevron centered at (x, y). */
export function chevronPath(ctx: Ctx, x: number, y: number, size: number): void {
  ctx.moveTo(x - size / 2, y - size);
  ctx.lineTo(x + size / 2, y);
  ctx.lineTo(x - size / 2, y + size);
}

export interface TextStyle {
  font: string;
  color: string;
  align?: CanvasTextAlign;
  /** Stroked first in this color, so the text stays legible over lines and dots. */
  halo?: string;
}

export function text(ctx: Ctx, s: string, x: number, y: number, style: TextStyle): void {
  ctx.font = style.font;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = 'middle';
  if (style.halo) {
    ctx.strokeStyle = style.halo;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = style.color;
  ctx.fillText(s, x, y);
}

export interface PillStyle {
  font: string;
  color: string;
  fill: string;
  stroke: string;
  padX?: number;
  heightPx?: number;
}

/** Text in a rounded pill centered at (cx, cy); returns the pill's width. */
export function pill(ctx: Ctx, s: string, cx: number, cy: number, style: PillStyle): number {
  ctx.font = style.font;
  const padX = style.padX ?? 4;
  const h = style.heightPx ?? 15;
  const w = Math.ceil(ctx.measureText(s).width) + 2 * padX;
  const r = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
  box(ctx, r, style.fill, style.stroke, 1, NO_DASH, h / 2);
  text(ctx, s, r.x + w / 2, r.y + h / 2, { font: style.font, color: style.color, align: 'center' });
  return w;
}
