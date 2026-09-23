// The tracked analyst (05 §7): a bold path from the router to the replica their latest turn landed
// on, labeled with its TTFT; when that turn moved replica, a faded path to the previous turn's
// replica and a "moved" bracket between the two (tab 4's lesson). The router column lists recent
// turns as text: turn, replica (R2→R5 when moved), and TTFT.

import type { SceneState, TrackedRequestView } from '../playback/types.ts';
import { colors } from '../ui/theme/colors.ts';
import { trackedStyle } from '../ui/theme/encodings.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import { replicaLabel, trackedOutcome } from './format.ts';
import type { Rect, SceneLayout } from './layout.ts';
import { arrowHeadPath, fittedText, pill, setDash, text, type Ctx } from './paint.ts';

const ARROW_PX = 6;
const FADED_DASH = [3, 2];
const STRIP_LINE_H_PX = 13;
const STRIP_HEADER_H_PX = 18;

/** The previous turn of the same session, when it is the request just before `i`. */
export function previousTurn(
  requests: readonly TrackedRequestView[],
  i: number,
): TrackedRequestView | null {
  const cur = requests[i];
  const prev = i > 0 ? requests[i - 1] : undefined;
  if (!cur || !prev || cur.turn <= 1 || prev.turn !== cur.turn - 1) return null;
  return prev;
}

/** "R5", or "R2→R5" when the turn moved from a known replica. */
export function routeLabel(requests: readonly TrackedRequestView[], i: number): string {
  const cur = requests[i]!;
  if (cur.replica === null) return 'router';
  const prev = previousTurn(requests, i);
  if (cur.moved && prev && prev.replica !== null && prev.replica !== cur.replica) {
    return `${replicaLabel(prev.replica)}→${replicaLabel(cur.replica)}`;
  }
  return replicaLabel(cur.replica);
}

/**
 * A turn's strip line, longest first, for fitText: "T3 R2→R5 2.4 s · 20 ms/tok", then without the
 * ms/tok suffix, then with tight units ("2.4s"), then with only the replica it landed on ("T3 R5").
 */
export function turnLines(requests: readonly TrackedRequestView[], i: number): string[] {
  const r = requests[i]!;
  const route = routeLabel(requests, i);
  const outcome = trackedOutcome(r);
  const head = `T${r.turn} ${route} ${outcome}`;
  const tight = outcome.replace(/(\d) (m?s|min)$/, '$1$2');
  const dest = r.replica === null ? 'router' : replicaLabel(r.replica);
  const lines = [head, `T${r.turn} ${route} ${tight}`, `T${r.turn} ${dest} ${tight}`];
  if (r.tpotMs !== null) lines.unshift(`${head} · ${Math.round(r.tpotMs)} ms/tok`);
  return lines;
}

function pathTo(ctx: Ctx, x0: number, x1: number, y: number): void {
  ctx.moveTo(x0, y);
  ctx.lineTo(x1 - ARROW_PX + 1, y);
}

export function drawTrackedPaths(ctx: Ctx, layout: SceneLayout, scene: SceneState): void {
  const reqs = scene.tracked?.requests;
  if (!reqs || reqs.length === 0) return;
  const i = reqs.length - 1;
  const cur = reqs[i]!;
  if (cur.replica === null) return;
  const lane = layout.lanes[cur.replica];
  if (!lane) return;
  const x0 = layout.router.x + layout.router.w;
  const y = Math.round(lane.cy);

  const prev = previousTurn(reqs, i);
  const prevLane =
    cur.moved && prev && prev.replica !== null && prev.replica !== cur.replica
      ? layout.lanes[prev.replica]
      : undefined;
  if (prevLane) {
    const py = Math.round(prevLane.cy);
    ctx.beginPath();
    pathTo(ctx, x0, prevLane.x - 2, py);
    ctx.strokeStyle = colors['ink-subtle'];
    ctx.lineWidth = 1.25;
    setDash(ctx, FADED_DASH);
    ctx.stroke();
    setDash(ctx, []);
    ctx.beginPath();
    arrowHeadPath(ctx, prevLane.x - 2, py, 1, 0, ARROW_PX);
    ctx.fillStyle = colors['ink-subtle'];
    ctx.fill();

    // The "moved" bracket: from the previous turn's path down (or up) to the current one.
    const bx = x0 + 5;
    const dir = y > py ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(bx, py);
    ctx.lineTo(bx, y - dir * ARROW_PX);
    ctx.strokeStyle = trackedStyle.haloStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    arrowHeadPath(ctx, bx, y, 0, dir, ARROW_PX);
    ctx.fillStyle = trackedStyle.haloStroke;
    ctx.fill();
    text(ctx, 'moved', bx + 4, (py + y) / 2, {
      font: canvasFonts.small,
      color: trackedStyle.labelColor,
      halo: trackedStyle.labelHalo,
    });
  }

  ctx.beginPath();
  pathTo(ctx, x0, lane.x - 2, y);
  ctx.strokeStyle = trackedStyle.haloStroke;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  arrowHeadPath(ctx, lane.x - 2, y, 1, 0, ARROW_PX);
  ctx.fillStyle = trackedStyle.haloStroke;
  ctx.fill();

  // Centered in the link zone (right of the bracket when there is one), but never over the router.
  const label = trackedOutcome(cur);
  ctx.font = canvasFonts.numeric;
  const half = ctx.measureText(label).width / 2 + 4;
  const mid = prevLane ? x0 + 14 + (layout.links.w - 14) / 2 : x0 + layout.links.w / 2;
  const cx = Math.max(mid - ARROW_PX / 2, x0 + (prevLane ? 12 : 2) + half);
  pill(ctx, label, cx, y, {
    font: canvasFonts.numeric,
    color: trackedStyle.labelColor,
    fill: trackedStyle.labelHalo,
    stroke: trackedStyle.haloStroke,
  });
}

/** The tracked analyst's recent turns, newest last, or a hint when nobody is tracked. */
export function drawTrackedStrip(ctx: Ctx, area: Rect, scene: SceneState): void {
  if (area.h < STRIP_HEADER_H_PX) return;
  ctx.beginPath();
  ctx.moveTo(area.x, area.y - 3.5);
  ctx.lineTo(area.x + area.w, area.y - 3.5);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  const tracked = scene.tracked;
  if (!tracked) {
    if (scene.detail === 'dots') {
      const hint = { font: canvasFonts.small, color: colors['ink-subtle'] };
      fittedText(ctx, ['Click a dot to track', 'Click a dot'], area.x, area.y + 8, area.w, hint);
      fittedText(
        ctx,
        ['an analyst', 'to track'],
        area.x,
        area.y + 8 + STRIP_LINE_H_PX,
        area.w,
        hint,
      );
    }
    return;
  }

  // Header: the halo glyph, as drawn around the analyst's dots, then their id.
  const gy = area.y + 8;
  ctx.beginPath();
  ctx.moveTo(area.x + 9, gy);
  ctx.arc(area.x + 5, gy, 4, 0, Math.PI * 2);
  ctx.strokeStyle = trackedStyle.haloStroke;
  ctx.lineWidth = trackedStyle.haloWidthPx;
  ctx.stroke();
  fittedText(
    ctx,
    [`Analyst ${tracked.analyst}`, String(tracked.analyst)],
    area.x + 14,
    gy,
    area.w - 14,
    {
      font: canvasFonts.label,
      color: trackedStyle.labelColor,
    },
  );

  const reqs = tracked.requests;
  const fit = Math.max(0, Math.floor((area.h - STRIP_HEADER_H_PX) / STRIP_LINE_H_PX));
  const first = Math.max(0, reqs.length - fit);
  if (reqs.length === 0 && fit > 0) {
    fittedText(
      ctx,
      ['No turns yet today', 'No turns yet'],
      area.x,
      area.y + STRIP_HEADER_H_PX + 6,
      area.w,
      { font: canvasFonts.small, color: colors['ink-subtle'] },
    );
    return;
  }
  for (let i = first; i < reqs.length; i++) {
    const y = area.y + STRIP_HEADER_H_PX + 6 + (i - first) * STRIP_LINE_H_PX;
    fittedText(ctx, turnLines(reqs, i), area.x, y, area.w, {
      font: canvasFonts.numeric,
      color: i === reqs.length - 1 ? colors.ink : colors['ink-subtle'],
    });
  }
}
