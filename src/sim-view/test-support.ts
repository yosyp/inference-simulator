// Test doubles for the canvas renderer: jsdom has no canvas, so tests draw into a recording 2D
// context that keeps every fill, stroke, and text call with the paint state and the path's shapes.
// Also scene builders. Used by tests only.

import { REPLICA_STATE, type ReplicaState } from '../engine/results.ts';
import type {
  DotState,
  DotView,
  ReplicaView,
  SceneState,
  TrackedRequestView,
} from '../playback/types.ts';
import type { Ctx } from './paint.ts';

/** A subpath: a full circle (arc), or a polyline of x, y pairs. */
export type SubPath =
  | { kind: 'arc'; x: number; y: number; r: number }
  | { kind: 'poly'; points: number[]; closed: boolean };

export interface PaintState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  dash: number[];
  font: string;
  textAlign: CanvasTextAlign;
  alpha: number;
}

export type DrawOp =
  | ({ op: 'fill' | 'stroke' | 'clip'; path: SubPath[] } & PaintState)
  | ({ op: 'fillRect'; x: number; y: number; w: number; h: number } & PaintState)
  | ({ op: 'fillText' | 'strokeText'; text: string; x: number; y: number } & PaintState)
  | ({ op: 'setTransform'; args: number[] } & PaintState);

export interface RecordingContext extends Ctx {
  readonly ops: DrawOp[];
  /** Every call, including path building, by method name. */
  readonly calls: Map<string, number>;
  reset(): void;
}

function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 10;
}

/** A recording CanvasRenderingContext2D stand-in. measureText is 0.6 em per character. */
export function createRecordingContext(): RecordingContext {
  const ops: DrawOp[] = [];
  const calls = new Map<string, number>();
  let path: SubPath[] = [];
  let current: Extract<SubPath, { kind: 'poly' }> | null = null;
  let dash: number[] = [];
  const stack: PaintState[] = [];

  const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const state = (): PaintState => ({
    fillStyle: String(ctx.fillStyle),
    strokeStyle: String(ctx.strokeStyle),
    lineWidth: ctx.lineWidth,
    dash: [...dash],
    font: ctx.font,
    textAlign: ctx.textAlign,
    alpha: ctx.globalAlpha,
  });
  const point = (x: number, y: number) => {
    if (!current) {
      current = { kind: 'poly', points: [], closed: false };
      path.push(current);
    }
    current.points.push(x, y);
  };

  const ctx: RecordingContext = {
    ops,
    calls,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    reset() {
      ops.length = 0;
      calls.clear();
      path = [];
      current = null;
    },
    save() {
      count('save');
      stack.push(state());
    },
    restore() {
      count('restore');
      const s = stack.pop();
      if (!s) return;
      ctx.fillStyle = s.fillStyle;
      ctx.strokeStyle = s.strokeStyle;
      ctx.lineWidth = s.lineWidth;
      ctx.font = s.font;
      ctx.textAlign = s.textAlign;
      ctx.globalAlpha = s.alpha;
      dash = s.dash;
    },
    setTransform(...args: unknown[]) {
      count('setTransform');
      ops.push({ op: 'setTransform', args: args as number[], ...state() });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      count('fillRect');
      ops.push({ op: 'fillRect', x, y, w, h, ...state() });
    },
    beginPath() {
      count('beginPath');
      path = [];
      current = null;
    },
    closePath() {
      count('closePath');
      if (current) current.closed = true;
      current = null;
    },
    moveTo(x: number, y: number) {
      count('moveTo');
      current = null;
      point(x, y);
    },
    lineTo(x: number, y: number) {
      count('lineTo');
      point(x, y);
    },
    arcTo(_x1: number, _y1: number, x2: number, y2: number) {
      count('arcTo');
      point(x2, y2);
    },
    quadraticCurveTo(_cx: number, _cy: number, x: number, y: number) {
      count('quadraticCurveTo');
      point(x, y);
    },
    arc(x: number, y: number, r: number) {
      count('arc');
      // The renderer moves to the arc's start first; that lone point belongs to the arc.
      if (current && current.points.length === 2) path.pop();
      path.push({ kind: 'arc', x, y, r });
      current = null;
    },
    rect(x: number, y: number, w: number, h: number) {
      count('rect');
      path.push({ kind: 'poly', points: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true });
      current = null;
    },
    fill() {
      count('fill');
      ops.push({ op: 'fill', path: [...path], ...state() });
    },
    stroke() {
      count('stroke');
      ops.push({ op: 'stroke', path: [...path], ...state() });
    },
    clip() {
      count('clip');
      ops.push({ op: 'clip', path: [...path], ...state() });
    },
    fillText(text: string, x: number, y: number) {
      count('fillText');
      ops.push({ op: 'fillText', text, x, y, ...state() });
    },
    strokeText(text: string, x: number, y: number) {
      count('strokeText');
      ops.push({ op: 'strokeText', text, x, y, ...state() });
    },
    measureText(text: string) {
      count('measureText');
      return { width: text.length * fontPx(ctx.font) * 0.6 } as TextMetrics;
    },
    setLineDash(segments: number[]) {
      count('setLineDash');
      dash = [...segments];
    },
  } as RecordingContext;
  return ctx;
}

/** A context whose methods do nothing, for timing drawScene itself. */
export function createNullContext(): Ctx & { calls: number } {
  const c = {
    calls: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
  } as unknown as Ctx & { calls: number };
  const noop = () => {
    c.calls++;
  };
  for (const m of [
    'save',
    'restore',
    'setTransform',
    'fillRect',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'arc',
    'arcTo',
    'rect',
    'quadraticCurveTo',
    'fill',
    'stroke',
    'clip',
    'fillText',
    'strokeText',
    'setLineDash',
  ]) {
    (c as unknown as Record<string, () => void>)[m] = noop;
  }
  (c as unknown as { measureText: (s: string) => TextMetrics }).measureText = (s) =>
    ({ width: s.length * 6.6 }) as TextMetrics;
  return c;
}

// --- Queries over recorded ops ------------------------------------------------------------------

export function texts(ctx: RecordingContext): string[] {
  return ctx.ops.flatMap((o) => (o.op === 'fillText' ? [o.text] : []));
}

type TextDrawOp = Extract<DrawOp, { text: string }>;

export function textOp(ctx: RecordingContext, text: string): TextDrawOp | undefined {
  return ctx.ops.find((o): o is TextDrawOp => o.op === 'fillText' && o.text === text);
}

/** Whether a subpath is a closed 4-point diamond (vertices straight above, right, below, left). */
export function isDiamond(p: SubPath): boolean {
  if (p.kind !== 'poly' || !p.closed || p.points.length !== 8) return false;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p.points as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return x0 === x2 && y1 === y3 && y0 < y2 && x3 < x1;
}

export interface ShapeHit {
  op: 'fill' | 'stroke';
  shape: 'circle' | 'diamond';
  x: number;
  y: number;
  r: number;
  color: string;
  lineWidth: number;
}

/** Every circle and diamond filled or stroked, with its paint color. */
export function shapes(ctx: RecordingContext): ShapeHit[] {
  const out: ShapeHit[] = [];
  for (const o of ctx.ops) {
    if (o.op !== 'fill' && o.op !== 'stroke') continue;
    const color = o.op === 'fill' ? o.fillStyle : o.strokeStyle;
    for (const p of o.path) {
      if (p.kind === 'arc') {
        out.push({
          op: o.op,
          shape: 'circle',
          x: p.x,
          y: p.y,
          r: p.r,
          color,
          lineWidth: o.lineWidth,
        });
      } else if (isDiamond(p)) {
        const pts = p.points;
        out.push({
          op: o.op,
          shape: 'diamond',
          x: pts[0]!,
          y: pts[3]!,
          r: pts[2]! - pts[0]!,
          color,
          lineWidth: o.lineWidth,
        });
      }
    }
  }
  return out;
}

// --- Scene builders -----------------------------------------------------------------------------

let nextRequest = 1;

export function dots(n: number, state: DotState, analyst = 7, tracked = false): DotView[] {
  const out: DotView[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ request: nextRequest++, analyst: analyst + i, state, progress: 0.5, tracked });
  }
  return out;
}

export function replica(
  r: number,
  over: Partial<ReplicaView> & { state?: ReplicaState } = {},
): ReplicaView {
  return {
    replica: r,
    state: REPLICA_STATE.ready,
    phaseProgress: null,
    kvUsedFrac: 0.5,
    running: 10,
    waiting: 2,
    preemptionsPerMin: 0,
    prefillTokensPerS: 4000,
    decodeTokensPerS: 800,
    nvidiaSmiUtil: 0.6,
    computeUtil: 0.2,
    dots: [],
    ...over,
  };
}

export function scene(over: Partial<SceneState> & { replicas?: ReplicaView[] } = {}): SceneState {
  return {
    atMs: 10 * 3_600_000,
    mode: 'live',
    detail: 'dots',
    router: { atRouter: [], offeredPerS: 3.2 },
    replicas: [replica(0)],
    tracked: null,
    ...over,
  };
}

export function turn(over: Partial<TrackedRequestView> & { turn: number }): TrackedRequestView {
  return {
    request: 1000 + over.turn,
    replica: 0,
    state: 'finished',
    ttftMs: 420,
    moved: false,
    ...over,
  };
}
