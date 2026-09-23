// One replica lane (05 §7): its state outline, KV tank, numbers, and either request dots or, in
// aggregate mode, flow bars (prefill and decode tokens/s) plus a queue-depth bar.

import type { ReplicaView } from '../playback/types.ts';
import { colors } from '../ui/theme/colors.ts';
import {
  dotStyles,
  kvTankStyle,
  replicaStyleKey,
  replicaStyles,
  type ReplicaStyle,
} from '../ui/theme/encodings.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import { drawDots, drawOverflow, placeLaneDots, type DotScratch } from './dots.ts';
import { formatCompact, formatCount, formatPercent, replicaLabel } from './format.ts';
import type { HitBuffer } from './hit-test.ts';
import { DOT_PITCH_PX, LANE_LABEL_W_PX, type LaneLayout, type Rect } from './layout.ts';
import { box, dotPath, hatch, setDash, text, type Ctx } from './paint.ts';

/** Full-scale values for the aggregate flow bars, shared by every lane in a frame. */
export interface FlowScale {
  prefillTokensPerS: number;
  decodeTokensPerS: number;
}

const LINE_H_PX = 12;
const DIVIDER_DASH = [2, 2];
const FLOW_LABEL_W_PX = 78;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function labelY(lane: LaneLayout): number {
  return lane.captions ? lane.y + 12 : lane.cy;
}

function blockTop(lane: LaneLayout): number {
  return lane.rowTop - DOT_PITCH_PX / 2;
}

export function drawTank(ctx: Ctx, r: Rect, frac: number): void {
  box(ctx, r, kvTankStyle.track, null, 1, [], 2);
  const f = clamp01(frac);
  if (f > 0) {
    const h = (r.h - 2) * f;
    ctx.fillStyle = kvTankStyle.fill;
    ctx.fillRect(r.x + 1, r.y + r.h - 1 - h, r.w - 2, h);
  }
  box(ctx, r, null, kvTankStyle.stroke, kvTankStyle.strokeWidthPx, [], 2);
}

function drawNumbers(ctx: Ctx, lane: LaneLayout, view: ReplicaView): void {
  const kv = `KV ${formatPercent(view.kvUsedFrac)}`;
  const run = formatCount(view.running);
  const wait = formatCount(view.waiting);
  const x = lane.numbers.x + 2;
  const n = lane.numberLines;
  const y0 = lane.cy - ((n - 1) * LINE_H_PX) / 2;
  const style = { font: canvasFonts.numeric, color: colors['ink-muted'] };
  text(ctx, kv, x, y0, { font: canvasFonts.numeric, color: colors.ink });
  if (n === 3) {
    text(ctx, `${run} running`, x, y0 + LINE_H_PX, style);
    text(ctx, `${wait} waiting`, x, y0 + 2 * LINE_H_PX, style);
  } else if (n === 2) {
    text(ctx, `${run} run · ${wait} wait`, x, y0 + LINE_H_PX, style);
  }
}

function drawCaptions(ctx: Ctx, lane: LaneLayout, aggregate: boolean): void {
  if (!lane.captions) return;
  const y = blockTop(lane) - 8;
  const style = { font: canvasFonts.small, color: colors['ink-subtle'] };
  text(ctx, aggregate ? 'queue' : 'waiting', lane.queue.x + lane.queue.w, y, {
    ...style,
    align: 'right',
  });
  text(ctx, aggregate ? 'prefill · decode tokens/s' : 'running', lane.batch.x, y, style);
}

function drawDivider(ctx: Ctx, lane: LaneLayout): void {
  const x = Math.round((lane.queue.x + lane.queue.w + lane.batch.x) / 2) + 0.5;
  const top = blockTop(lane);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, top + lane.rows * DOT_PITCH_PX);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  setDash(ctx, DIVIDER_DASH);
  ctx.stroke();
  setDash(ctx, []);
}

/** Aggregate mode: queue depth as a bar growing left from the divider, and two rate bars. */
function drawFlow(ctx: Ctx, lane: LaneLayout, view: ReplicaView, scale: FlowScale): void {
  const top = blockTop(lane);
  const blockH = lane.rows * DOT_PITCH_PX;
  const mid = top + blockH / 2;

  const waiting = Number.isFinite(view.waiting) ? Math.max(0, view.waiting) : 0;
  if (waiting > 0) {
    const len = Math.min(lane.queue.w, Math.max(2, Math.ceil(waiting / lane.rows) * DOT_PITCH_PX));
    const q = dotStyles.queued;
    const r = { x: lane.queue.x + lane.queue.w - len, y: top + 1, w: len, h: blockH - 2 };
    box(ctx, r, q.fill, q.stroke, q.strokeWidthPx, [], 2);
  }

  const bh = Math.max(3, Math.min(8, (blockH - 3) / 2));
  const barX = lane.batch.x + 12;
  const maxLen = Math.max(0, lane.batch.w - 12 - FLOW_LABEL_W_PX);
  const bars = [
    { style: dotStyles.prefill, v: view.prefillTokensPerS, full: scale.prefillTokensPerS },
    { style: dotStyles.decode, v: view.decodeTokensPerS, full: scale.decodeTokensPerS },
  ] as const;
  for (let i = 0; i < 2; i++) {
    const { style, v, full } = bars[i]!;
    const y = i === 0 ? mid - 1.5 - bh : mid + 1.5;
    const cy = y + bh / 2;
    ctx.beginPath();
    dotPath(ctx, style.shape, lane.batch.x + 5, cy, Math.min(3.5, style.radiusPx));
    ctx.fillStyle = style.fill ?? colors['canvas-bg'];
    ctx.fill();
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    const len = maxLen * clamp01(full > 0 ? v / full : 0);
    if (len > 0) box(ctx, { x: barX, y, w: len, h: bh }, style.fill, style.stroke, 1, [], 1);
    text(ctx, `${formatCompact(v)} tok/s`, barX + len + 4, cy, {
      font: canvasFonts.numeric,
      color: colors['ink-muted'],
    });
  }
}

function drawLoading(ctx: Ctx, lane: LaneLayout, view: ReplicaView, style: ReplicaStyle): void {
  const progress = clamp01(view.phaseProgress ?? 0);
  const label = `${style.label} ${Math.round(progress * 100)}%`;
  ctx.font = canvasFonts.label;
  const labelW = ctx.measureText(label).width;
  text(ctx, label, lane.queue.x, lane.cy, { font: canvasFonts.label, color: style.ink });
  const x = lane.queue.x + labelW + 10;
  const w = Math.max(0, lane.batch.x + lane.batch.w - x);
  if (style.progress && w > 0) {
    const r = { x, y: Math.round(lane.cy - 3), w, h: 6 };
    box(ctx, r, style.progress.track, null, 1, [], 3);
    if (progress > 0) box(ctx, { ...r, w: w * progress }, style.progress.fill, null, 1, [], 3);
  }
}

export function drawLane(
  ctx: Ctx,
  lane: LaneLayout,
  view: ReplicaView,
  aggregate: boolean,
  scratch: DotScratch,
  hits: HitBuffer | undefined,
  scale: FlowScale,
): void {
  const key = replicaStyleKey(view.state);
  const style = replicaStyles[key];
  box(ctx, lane, style.fill, null);
  if (style.hatch) hatch(ctx, lane, style.hatch.color, style.hatch.spacingPx, style.hatch.widthPx);
  box(ctx, lane, null, style.stroke, style.strokeWidthPx, style.dash);
  text(ctx, replicaLabel(view.replica), lane.x + 8, labelY(lane), {
    font: canvasFonts.label,
    color: style.ink,
  });

  if (key === 'down' || key === 'crashed') {
    const x = lane.x + LANE_LABEL_W_PX;
    text(ctx, style.label, x, lane.cy, {
      font: canvasFonts.label,
      color: style.ink,
      halo: style.fill,
    });
    return;
  }
  drawTank(ctx, lane.tank, view.kvUsedFrac);
  drawNumbers(ctx, lane, view);
  if (key !== 'ready') {
    drawLoading(ctx, lane, view, style);
    return;
  }
  drawCaptions(ctx, lane, aggregate);
  drawDivider(ctx, lane);
  if (aggregate) {
    drawFlow(ctx, lane, view, scale);
    return;
  }
  placeLaneDots(scratch, view.dots, lane);
  drawDots(ctx, view.dots, scratch, hits);
  drawOverflow(ctx, scratch.queue);
  drawOverflow(ctx, scratch.batch);
}

/** High side (05 §9): the outline and name only; no state, tank, numbers, or dots. */
export function drawQuietLane(ctx: Ctx, lane: LaneLayout, replica: number): void {
  box(ctx, lane, null, colors['high-side-outline'], 1);
  text(ctx, replicaLabel(replica), lane.x + 8, labelY(lane), {
    font: canvasFonts.label,
    color: colors['ink-subtle'],
  });
}
