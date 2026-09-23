// The router column and the links to each replica (05 §7). Links to replicas the router still sends
// to (Ready, and Crashed until detection) are chevron trails ending in an arrowhead; links to Down
// or Loading replicas are faint dashed lines. In dot mode the chevrons drift with simulated time.

import { REPLICA_STATE } from '../engine/results.ts';
import type { SceneState } from '../playback/types.ts';
import { colors } from '../ui/theme/colors.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import { drawDots, drawOverflow, placeRouterDots, type DotScratch } from './dots.ts';
import { formatRate } from './format.ts';
import type { HitBuffer } from './hit-test.ts';
import type { Rect, SceneLayout } from './layout.ts';
import { arrowHeadPath, box, chevronPath, fittedText, setDash, type Ctx } from './paint.ts';

const CHEVRON_SPACING_PX = 12;
/** Chevron drift per simulated second: a crawl at 1×, brisk at 10×. */
const CHEVRON_PX_PER_SIM_S = 6;
const ARROW_PX = 6;
const IDLE_DASH = [3, 3];
/** Router content above the tracked strip: title, rate, and two rows of waiting requests. */
export const ROUTER_HEADER_H_PX = 60;

/** Whether the router still sends to a replica in this state. */
export function routerSendsTo(state: number): boolean {
  return state === REPLICA_STATE.ready || state === REPLICA_STATE.crashed;
}

export function drawLinks(ctx: Ctx, layout: SceneLayout, scene: SceneState, quiet: boolean): void {
  const x0 = layout.router.x + layout.router.w;
  const lanes = layout.lanes;

  // Idle links: Down or Loading replicas, and every link on the quiet high side.
  ctx.beginPath();
  let anyIdle = false;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const view = scene.replicas[i];
    if (!quiet && view && routerSendsTo(view.state)) continue;
    const y = Math.round(lane.cy) + 0.5;
    ctx.moveTo(x0, y);
    ctx.lineTo(lane.x - 2, y);
    anyIdle = true;
  }
  if (anyIdle) {
    ctx.strokeStyle = quiet ? colors['high-side-outline'] : colors.flow;
    ctx.lineWidth = 1;
    setDash(ctx, IDLE_DASH);
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
    setDash(ctx, []);
  }
  if (quiet) return;

  const drift =
    scene.detail === 'dots'
      ? ((scene.atMs / 1000) * CHEVRON_PX_PER_SIM_S) % CHEVRON_SPACING_PX
      : CHEVRON_SPACING_PX / 2;
  ctx.beginPath();
  let anyActive = false;
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const view = scene.replicas[i];
    if (!view || !routerSendsTo(view.state)) continue;
    const end = lane.x - 2 - ARROW_PX - 3;
    for (let x = x0 + 4 + drift; x < end; x += CHEVRON_SPACING_PX) {
      chevronPath(ctx, x, lane.cy, 3);
    }
    anyActive = true;
  }
  if (!anyActive) return;
  ctx.strokeStyle = colors.flow;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.lineJoin = 'miter';

  ctx.beginPath();
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const view = scene.replicas[i];
    if (!view || !routerSendsTo(view.state)) continue;
    arrowHeadPath(ctx, lane.x - 2, lane.cy, 1, 0, ARROW_PX);
  }
  ctx.fillStyle = colors.flow;
  ctx.fill();
}

/** The router box: title, offered rate, and requests waiting at the router. Returns the strip area. */
export function drawRouter(
  ctx: Ctx,
  layout: SceneLayout,
  scene: SceneState,
  scratch: DotScratch,
  hits: HitBuffer | undefined,
): Rect {
  const r = layout.router;
  box(ctx, r, colors.router, colors['border-strong'], 1);
  // Text stays inside the box at every width: longest form first, then an ellipsis (fitText).
  const textW = r.w - 16;
  fittedText(ctx, ['Router'], r.x + 8, r.y + 12, textW, {
    font: canvasFonts.label,
    color: colors.ink,
  });
  const rate = formatRate(scene.router.offeredPerS);
  fittedText(ctx, [`${rate} req/s`, `${rate}/s`, rate], r.x + 8, r.y + 27, textW, {
    font: canvasFonts.numeric,
    color: colors['ink-muted'],
  });
  const dots = scene.router.atRouter;
  if (dots.length > 0) {
    const area = { x: r.x + 6, y: r.y + 36, w: r.w - 12, h: 20 };
    placeRouterDots(scratch, dots, area, 2, r.y + 42);
    drawDots(ctx, dots, scratch, hits);
    drawOverflow(ctx, scratch.queue);
  }
  return {
    x: r.x + 8,
    y: r.y + ROUTER_HEADER_H_PX,
    w: r.w - 16,
    h: Math.max(0, r.h - ROUTER_HEADER_H_PX - 6),
  };
}

/** High side: the router's outline and name only. */
export function drawQuietRouter(ctx: Ctx, layout: SceneLayout): void {
  const r = layout.router;
  box(ctx, r, null, colors['high-side-outline'], 1);
  fittedText(ctx, ['Router'], r.x + 8, r.y + 12, r.w - 16, {
    font: canvasFonts.label,
    color: colors['ink-subtle'],
  });
}
