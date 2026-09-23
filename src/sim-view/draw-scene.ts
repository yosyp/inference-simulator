// drawScene: the canvas as a pure function of a SceneState (05 §7, §9; CLAUDE.md). The same scene and
// viewport always produce the same drawing; nothing depends on wall time. Scratch (layout, dot
// positions) is reused across frames, so a frame allocates nothing per dot.

import type { SceneState } from '../playback/types.ts';
import { colors } from '../ui/theme/colors.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import { createDotScratch, type DotScratch } from './dots.ts';
import { clearHits, type HitBuffer } from './hit-test.ts';
import { drawLane, drawQuietLane, type FlowScale } from './lane.ts';
import { computeLayout, type SceneLayout, type Viewport } from './layout.ts';
import { pill, type Ctx } from './paint.ts';
import { drawLinks, drawQuietRouter, drawRouter } from './router.ts';
import { drawTrackedPaths, drawTrackedStrip } from './tracked.ts';

export interface DrawScratch {
  dots: DotScratch;
  layout: SceneLayout | null;
  scale: FlowScale;
}

export function createDrawScratch(): DrawScratch {
  return {
    dots: createDotScratch(),
    layout: null,
    scale: { prefillTokensPerS: 0, decodeTokensPerS: 0 },
  };
}

export interface DrawOptions {
  /** Filled with every drawn dot's position, for click-to-track (hit-test.ts). */
  hits?: HitBuffer;
  /** Reused across frames. Default: one shared module-level scratch. */
  scratch?: DrawScratch;
}

/** Floors for the aggregate bars' full scale, so an idle fleet doesn't blow up tiny rates. */
const MIN_PREFILL_SCALE = 1000;
const MIN_DECODE_SCALE = 100;

export const HIGH_SIDE_NOTE = 'High side: no live telemetry';

const shared = createDrawScratch();

/** The next 1, 2, or 5 × 10^k at or above v. Keeps the flow bars' scale from twitching. */
export function niceCeil(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function layoutFor(s: DrawScratch, viewport: Viewport, replicas: number): SceneLayout {
  const l = s.layout;
  if (
    l &&
    l.lanes.length === replicas &&
    l.viewport.widthPx === viewport.widthPx &&
    l.viewport.heightPx === viewport.heightPx &&
    l.viewport.dpr === viewport.dpr
  ) {
    return l;
  }
  s.layout = computeLayout(viewport, replicas);
  return s.layout;
}

function flowScale(scene: SceneState, out: FlowScale): FlowScale {
  let p = 0;
  let d = 0;
  for (const r of scene.replicas) {
    if (r.prefillTokensPerS > p) p = r.prefillTokensPerS;
    if (r.decodeTokensPerS > d) d = r.decodeTokensPerS;
  }
  out.prefillTokensPerS = niceCeil(Math.max(MIN_PREFILL_SCALE, p));
  out.decodeTokensPerS = niceCeil(Math.max(MIN_DECODE_SCALE, d));
  return out;
}

function drawHighSide(ctx: Ctx, layout: SceneLayout, scene: SceneState): void {
  drawLinks(ctx, layout, scene, true);
  drawQuietRouter(ctx, layout);
  for (let i = 0; i < layout.lanes.length; i++) {
    drawQuietLane(ctx, layout.lanes[i]!, scene.replicas[i]?.replica ?? i);
  }
  const first = layout.lanes[0];
  const last = layout.lanes[layout.lanes.length - 1];
  const cx = first ? (first.x + (last!.x + last!.w)) / 2 : layout.viewport.widthPx / 2;
  const cy = first ? (first.y + (last!.y + last!.h)) / 2 : layout.viewport.heightPx / 2;
  pill(ctx, HIGH_SIDE_NOTE, cx, Math.round(cy), {
    font: canvasFonts.small,
    color: colors['high-side-empty-ink'],
    fill: colors['high-side-empty'],
    stroke: colors['high-side-empty-hatch'],
    padX: 8,
    heightPx: 20,
  });
}

/**
 * Draws the scene into a viewport of CSS pixels, scaling by viewport.dpr. Returns the layout used,
 * which callers may keep for hover and hit tests (it is cached while the viewport and replica
 * count stay the same).
 */
export function drawScene(
  ctx: Ctx,
  scene: SceneState,
  viewport: Viewport,
  opts: DrawOptions = {},
): SceneLayout {
  const scratch = opts.scratch ?? shared;
  const hits = opts.hits;
  if (hits) clearHits(hits);
  const layout = layoutFor(scratch, viewport, scene.replicas.length);

  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.fillStyle = colors['canvas-bg'];
  ctx.fillRect(0, 0, viewport.widthPx, viewport.heightPx);

  if (scene.mode === 'highSide') {
    drawHighSide(ctx, layout, scene);
    return layout;
  }

  const aggregate = scene.detail === 'aggregate';
  drawLinks(ctx, layout, scene, false);
  const strip = drawRouter(ctx, layout, scene, scratch.dots, hits);
  drawTrackedStrip(ctx, strip, scene);
  const scale = flowScale(scene, scratch.scale);
  for (let i = 0; i < layout.lanes.length; i++) {
    const view = scene.replicas[i];
    if (view) drawLane(ctx, layout.lanes[i]!, view, aggregate, scratch.dots, hits, scale);
  }
  drawTrackedPaths(ctx, layout, scene);
  return layout;
}
