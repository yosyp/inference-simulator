// Canvas geometry (05 §7): the router on the left, then a link zone, then one lane per replica.
// Lanes stack in a single column (so a tracked turn that moves replica reads as a vertical jump);
// they wrap into more columns only when a lane would be shorter than MIN_LANE_H.
//
// Inside a lane, left to right: the replica label, the queue (fills leftward from the divider, so
// the head of the queue sits next to the batch), the batch (fills rightward from the divider), the
// KV tank, and the numbers. Queue and batch lengths grow with their counts, so lanes compare like
// bars. All sizes are CSS px.

export interface Viewport {
  widthPx: number;
  heightPx: number;
  /** devicePixelRatio; the backing store is widthPx × dpr by heightPx × dpr. */
  dpr: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaneLayout extends Rect {
  replica: number;
  /** Where links and tracked paths meet the lane. */
  cy: number;
  queue: Rect;
  batch: Rect;
  tank: Rect;
  numbers: Rect;
  /** 1: KV only; 2: KV, then running and waiting on one line; 3: one line each. */
  numberLines: 1 | 2 | 3;
  /** Room for "waiting" / "running" captions above the dots. */
  captions: boolean;
  /** Dot rows, and the y of the first row's centers. */
  rows: number;
  rowTop: number;
}

export interface SceneLayout {
  viewport: Viewport;
  router: Rect;
  /** The zone between the router and the lanes, where links and tracked paths run. */
  links: Rect;
  lanes: LaneLayout[];
  columns: number;
}

export const PAD_PX = 8;
/** Dot grid pitch: fits the largest dot (r 4.5) with a pixel to spare. */
export const DOT_PITCH_PX = 10;
/** Columns may squeeze to this pitch (dots overlap) before the rest become a "+N" label. */
export const MIN_DOT_PITCH_X_PX = 5;
/** More rows than this makes the dot blocks read as blobs rather than lengths. */
export const MAX_DOT_ROWS = 10;
export const MIN_LANE_H_PX = 22;
export const LANE_LABEL_W_PX = 32;
export const CAPTION_H_PX = 14;
/** Fits "KV 100%"; "256 run · 999 wait"; "999 waiting" in 11 px mono. */
const NUMBERS_W_PX: Record<1 | 2 | 3, number> = { 1: 50, 2: 122, 3: 80 };
const NUMBERS_PAD_R_PX = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function laneGap(rowsPerColumn: number): number {
  return rowsPerColumn <= 2 ? 8 : rowsPerColumn <= 4 ? 6 : 4;
}

function laneInterior(replica: number, x: number, y: number, w: number, h: number): LaneLayout {
  const numberLines: 1 | 2 | 3 = h >= 44 ? 3 : h >= 26 ? 2 : 1;
  const numbersW = Math.min(NUMBERS_W_PX[numberLines], Math.max(0, w * 0.2));
  const tankW = h >= 60 ? 14 : 10;
  const tankInset = h >= 30 ? 4 : 3;
  const numbers = { x: x + w - NUMBERS_PAD_R_PX - numbersW, y, w: numbersW, h };
  const tank = { x: numbers.x - 6 - tankW, y: y + tankInset, w: tankW, h: h - 2 * tankInset };
  const dotsX = x + LANE_LABEL_W_PX;
  const dotsW = Math.max(0, tank.x - 8 - dotsX);
  const queueW = Math.round(dotsW * 0.42);
  const queue = { x: dotsX, y, w: Math.max(0, queueW - 4), h };
  const batch = { x: dotsX + queueW + 4, y, w: Math.max(0, dotsW - queueW - 4), h };
  const captions = h >= 56;
  const top = captions ? CAPTION_H_PX : 0;
  const rows = clamp(Math.floor((h - 6 - top) / DOT_PITCH_PX), 1, MAX_DOT_ROWS);
  const blockTop = y + top + (h - top - rows * DOT_PITCH_PX) / 2;
  return {
    replica,
    x,
    y,
    w,
    h,
    cy: y + h / 2,
    queue,
    batch,
    tank,
    numbers,
    numberLines,
    captions,
    rows,
    rowTop: blockTop + DOT_PITCH_PX / 2,
  };
}

/** Pure geometry for a viewport and a replica count. Lanes are in replica order, column-major. */
export function computeLayout(viewport: Viewport, replicas: number): SceneLayout {
  const W = Math.max(0, viewport.widthPx);
  const H = Math.max(0, viewport.heightPx);
  const innerH = Math.max(0, H - 2 * PAD_PX);
  const routerW = Math.round(clamp(W * 0.15, 96, 168));
  const linksW = Math.round(clamp(W * 0.064, 36, 72));
  const router = { x: PAD_PX, y: PAD_PX, w: routerW, h: innerH };
  const links = { x: router.x + routerW, y: PAD_PX, w: linksW, h: innerH };
  const lanesX = links.x + linksW;
  const lanesW = Math.max(0, W - PAD_PX - lanesX);

  let columns = 1;
  const n = Math.max(0, replicas);
  const laneHFor = (cols: number) => {
    const perCol = Math.ceil(n / cols);
    return (innerH - laneGap(perCol) * (perCol - 1)) / perCol;
  };
  while (n > 1 && columns < n && laneHFor(columns) < MIN_LANE_H_PX) columns++;
  const perColumn = n === 0 ? 0 : Math.ceil(n / columns);
  const gap = laneGap(perColumn);
  const colGap = 8;
  const laneW = (lanesW - colGap * (columns - 1)) / columns;
  const laneH = perColumn === 0 ? 0 : (innerH - gap * (perColumn - 1)) / perColumn;

  const lanes: LaneLayout[] = [];
  for (let r = 0; r < n; r++) {
    const col = Math.floor(r / perColumn);
    const row = r % perColumn;
    const x0 = Math.round(lanesX + col * (laneW + colGap));
    const x1 = Math.round(lanesX + col * (laneW + colGap) + laneW);
    const y0 = Math.round(PAD_PX + row * (laneH + gap));
    const y1 = Math.round(PAD_PX + row * (laneH + gap) + laneH);
    lanes.push(laneInterior(r, x0, y0, x1 - x0, y1 - y0));
  }
  return { viewport, router, links, lanes, columns };
}

/** The lane containing a point, or -1. */
export function laneAt(layout: SceneLayout, x: number, y: number): number {
  for (const lane of layout.lanes) {
    if (x >= lane.x && x < lane.x + lane.w && y >= lane.y && y < lane.y + lane.h) {
      return lane.replica;
    }
  }
  return -1;
}
