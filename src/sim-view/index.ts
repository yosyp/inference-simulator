// The canvas renderer (00-build U3; 05 §7, §9, §10).
//
// SimCanvas({ store }) is the component X1 mounts in AppShell's canvas slot. drawScene is the pure
// drawing function underneath it; describeScene is its text alternative; the hit buffer backs
// click-to-track.

export { SimCanvas, SIM_CANVAS_LABEL, type SimCanvasProps } from './SimCanvas.tsx';
export {
  HIGH_SIDE_NOTE,
  createDrawScratch,
  drawScene,
  niceCeil,
  type DrawOptions,
  type DrawScratch,
} from './draw-scene.ts';
export { describeScene } from './describe.ts';
export {
  HIT_SLOP_PX,
  analystAt,
  clearHits,
  createHitBuffer,
  hitTest,
  pushHit,
  type HitBuffer,
} from './hit-test.ts';
export {
  computeLayout,
  laneAt,
  type LaneLayout,
  type Rect,
  type SceneLayout,
  type Viewport,
} from './layout.ts';
export type { Ctx } from './paint.ts';
