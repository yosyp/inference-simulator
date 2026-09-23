import { describe, expect, it } from 'vitest';
import { REPLICA_STATE } from '../engine/results.ts';
import type { SceneState } from '../playback/types.ts';
import { colors } from '../ui/theme/colors.ts';
import { dotStyles, replicaStyles, trackedStyle } from '../ui/theme/encodings.ts';
import { HIGH_SIDE_NOTE, createDrawScratch, drawScene, niceCeil } from './draw-scene.ts';
import { createHitBuffer } from './hit-test.ts';
import { fitText } from './paint.ts';
import { turnLines } from './tracked.ts';
import { canvasFonts } from '../ui/theme/typography.ts';
import type { LaneLayout, Rect, SceneLayout, Viewport } from './layout.ts';
import {
  createRecordingContext,
  dots,
  replica,
  scene,
  shapes,
  textOp,
  texts,
  turn,
  type DrawOp,
  type RecordingContext,
  type ShapeHit,
  type SubPath,
} from './test-support.ts';

const SLOT: Viewport = { widthPx: 1008, heightPx: 271, dpr: 1 };

function draw(s: SceneState, viewport: Viewport = SLOT) {
  const ctx = createRecordingContext();
  const hits = createHitBuffer();
  const layout = drawScene(ctx, s, viewport, { hits, scratch: createDrawScratch() });
  return { ctx, layout, hits };
}

function bbox(path: SubPath[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of path) {
    if (p.kind === 'arc') {
      x0 = Math.min(x0, p.x - p.r);
      x1 = Math.max(x1, p.x + p.r);
      y0 = Math.min(y0, p.y - p.r);
      y1 = Math.max(y1, p.y + p.r);
    } else {
      for (let i = 0; i < p.points.length; i += 2) {
        x0 = Math.min(x0, p.points[i]!);
        x1 = Math.max(x1, p.points[i]!);
        y0 = Math.min(y0, p.points[i + 1]!);
        y1 = Math.max(y1, p.points[i + 1]!);
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function isBoxOf(path: SubPath[], r: Rect, slack = 1.5): boolean {
  const b = bbox(path);
  return (
    Math.abs(b.x - r.x) <= slack &&
    Math.abs(b.y - r.y) <= slack &&
    Math.abs(b.x + b.w - (r.x + r.w)) <= slack &&
    Math.abs(b.y + b.h - (r.y + r.h)) <= slack
  );
}

type PathOp = Extract<DrawOp, { path: SubPath[] }>;

function outline(ctx: RecordingContext, lane: Rect): PathOp {
  const op = ctx.ops.find(
    (o): o is PathOp => o.op === 'stroke' && o.path.length === 1 && isBoxOf(o.path, lane),
  );
  if (!op) throw new Error('no outline for lane');
  return op;
}

function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function dotsIn(ctx: RecordingContext, r: Rect): ShapeHit[] {
  return shapes(ctx).filter((s) => inRect(s.x, s.y, r));
}

function kvFills(ctx: RecordingContext, lane: LaneLayout) {
  return ctx.ops.filter(
    (o): o is Extract<DrawOp, { op: 'fillRect' }> =>
      o.op === 'fillRect' && o.fillStyle === colors.kv && inRect(o.x, o.y, lane),
  );
}

const statesScene = scene({
  replicas: [
    replica(0, { kvUsedFrac: 0.5, dots: dots(4, 'decode') }),
    replica(1, { state: REPLICA_STATE.crashed, dots: dots(5, 'decode') }),
    replica(2, { state: REPLICA_STATE.down }),
    replica(3, { state: REPLICA_STATE.loadingWeights, phaseProgress: 0.4, kvUsedFrac: 0 }),
    replica(4, { state: REPLICA_STATE.initializingEngine, phaseProgress: 0.7, kvUsedFrac: 0 }),
    replica(5, { kvUsedFrac: 0, running: 0, waiting: 0 }),
    replica(6, { kvUsedFrac: NaN, running: NaN, waiting: NaN }),
    replica(7),
  ],
});

describe('drawScene: frame', () => {
  it('scales by devicePixelRatio and paints the background over the CSS viewport', () => {
    const { ctx } = draw(scene(), { ...SLOT, dpr: 2 });
    const first = ctx.ops[0]!;
    expect(first.op).toBe('setTransform');
    expect(first.op === 'setTransform' && first.args).toEqual([2, 0, 0, 2, 0, 0]);
    expect(ctx.ops[1]).toMatchObject({
      op: 'fillRect',
      x: 0,
      y: 0,
      w: SLOT.widthPx,
      h: SLOT.heightPx,
      fillStyle: colors['canvas-bg'],
    });
  });

  it('is a pure function of the scene', () => {
    const s = scene({ replicas: [replica(0, { dots: dots(30, 'decode') }), replica(1)] });
    expect(draw(s).ctx.ops).toEqual(draw(s).ctx.ops);
  });

  it('drifts the router chevrons with simulated time in dot mode only', () => {
    const at = (atMs: number, detail: 'dots' | 'aggregate') =>
      draw(scene({ atMs, detail, replicas: [replica(0), replica(1)] })).ctx.ops;
    expect(at(1000, 'dots')).not.toEqual(at(1500, 'dots'));
    expect(at(1000, 'aggregate')).toEqual(at(1500, 'aggregate'));
  });

  it.each([1, 2, 4, 8])('draws %i replicas inside the viewport', (n) => {
    const s = scene({
      replicas: [...Array(n).keys()].map((r) =>
        replica(r, { dots: [...dots(20, 'decode'), ...dots(10, 'queued')] }),
      ),
    });
    const { ctx, layout } = draw(s);
    for (let r = 0; r < n; r++) expect(texts(ctx)).toContain(`R${r + 1}`);
    const canvas = { x: 0, y: 0, w: SLOT.widthPx, h: SLOT.heightPx };
    for (const sh of shapes(ctx)) expect(inRect(sh.x, sh.y, canvas)).toBe(true);
    for (const o of ctx.ops) if (o.op === 'fillText') expect(inRect(o.x, o.y, canvas)).toBe(true);
    // Every drawn dot sits in its own replica's lane.
    for (const lane of layout.lanes) expect(dotsIn(ctx, lane).length).toBeGreaterThanOrEqual(30);
  });
});

describe('drawScene: replica states', () => {
  const { ctx, layout } = draw(statesScene);
  const lane = (r: number) => layout.lanes[r]!;

  it('outlines a Ready replica and fills its tank to kvUsedFrac', () => {
    expect(outline(ctx, lane(0))).toMatchObject({
      strokeStyle: replicaStyles.ready.stroke,
      lineWidth: 1,
      dash: [],
    });
    const [fill] = kvFills(ctx, lane(0));
    expect(fill!.h).toBeCloseTo((lane(0).tank.h - 2) * 0.5, 5);
    expect(texts(ctx)).toContain('KV 50%');
  });

  it('draws Crashed with hatching, a heavy vermillion border, a label, and no tank or dots', () => {
    const l = lane(1);
    expect(outline(ctx, l)).toMatchObject({
      strokeStyle: colors['replica-crashed-stroke'],
      lineWidth: 2,
    });
    expect(ctx.ops.some((o) => o.op === 'clip' && isBoxOf(o.path, l))).toBe(true);
    expect(
      ctx.ops.some(
        (o) =>
          o.op === 'stroke' &&
          o.strokeStyle === colors['replica-down-hatch'] &&
          inRect(bbox(o.path).x + 1, l.cy, { ...l, x: l.x - l.h - 1, w: l.w + l.h + 2 }),
      ),
    ).toBe(true);
    expect(textOp(ctx, 'Crashed')?.fillStyle).toBe(colors['replica-down-ink']);
    expect(kvFills(ctx, l)).toHaveLength(0);
    expect(dotsIn(ctx, l)).toHaveLength(0);
  });

  it('draws Down dark and hatched with a label', () => {
    expect(outline(ctx, lane(2)).strokeStyle).toBe(colors['replica-down-stroke']);
    expect(ctx.ops.some((o) => o.op === 'clip' && isBoxOf(o.path, lane(2)))).toBe(true);
    expect(textOp(ctx, 'Down')).toBeDefined();
  });

  it('draws Loading with a dashed outline, the phase, and its progress', () => {
    for (const [r, label, progress] of [
      [3, 'Loading weights 40%', 0.4],
      [4, 'Starting engine 70%', 0.7],
    ] as const) {
      const l = lane(r);
      expect(outline(ctx, l)).toMatchObject({ dash: [5, 3], lineWidth: 1.5 });
      expect(textOp(ctx, label)).toBeDefined();
      const bars = ctx.ops.filter(
        (o): o is PathOp => o.op === 'fill' && inRect(bbox(o.path).x, bbox(o.path).y, l),
      );
      const track = bars.find((o) => o.fillStyle === colors['kv-track'] && bbox(o.path).h === 6);
      const bar = bars.find((o) => o.fillStyle === colors['replica-loading']);
      expect(bbox(bar!.path).w / bbox(track!.path).w).toBeCloseTo(progress, 5);
    }
  });

  it('shows an empty tank on a replica that has just rejoined', () => {
    const l = lane(5);
    expect(outline(ctx, l).strokeStyle).toBe(replicaStyles.ready.stroke);
    expect(kvFills(ctx, l)).toHaveLength(0);
    // The tank itself is still there.
    expect(
      ctx.ops.some(
        (o) => o.op === 'fill' && o.fillStyle === colors['kv-track'] && isBoxOf(o.path, l.tank),
      ),
    ).toBe(true);
  });

  it('prints missing numbers as a dash', () => {
    expect(texts(ctx)).toContain('KV —');
    expect(texts(ctx)).toContain('— run · — wait');
  });

  it('keeps links to replicas the router still sends to, and dashes the rest', () => {
    const chevronOps = ctx.ops.filter(
      (o): o is PathOp => o.op === 'stroke' && o.strokeStyle === colors.flow && o.dash.length === 0,
    );
    const ys = new Set(chevronOps.flatMap((o) => o.path.map((p) => Math.round(bbox([p]).y + 3))));
    // Ready and Crashed lanes have chevrons; Down and Loading don't.
    for (const r of [0, 1, 5, 6, 7]) expect(ys.has(Math.round(lane(r).cy))).toBe(true);
    for (const r of [2, 3, 4]) expect(ys.has(Math.round(lane(r).cy))).toBe(false);
    const idle = ctx.ops.find((o) => o.op === 'stroke' && o.dash.join() === '3,3');
    expect(idle && 'path' in idle && idle.path).toHaveLength(3);
  });
});

describe('drawScene: dots', () => {
  function oneOfEach() {
    const s = scene({
      replicas: [
        replica(0, {
          dots: [
            ...dots(1, 'queued'),
            ...dots(1, 'prefill'),
            ...dots(1, 'decode'),
            ...dots(1, 'preempted'),
          ],
        }),
      ],
    });
    return draw(s, { widthPx: 1008, heightPx: 60, dpr: 1 });
  }

  it('draws each state with its shape, size, and colors', () => {
    const { ctx, layout } = oneOfEach();
    const all = dotsIn(ctx, layout.lanes[0]!);
    const find = (shape: string, r: number, op: string) =>
      all.filter((s) => s.shape === shape && s.r === r && s.op === op);
    const q = dotStyles.queued;
    expect(find('circle', q.radiusPx, 'fill')[0]?.color).toBe(q.fill);
    expect(find('circle', q.radiusPx, 'stroke')[0]).toMatchObject({
      color: q.stroke,
      lineWidth: q.strokeWidthPx,
    });
    const p = dotStyles.prefill;
    expect(find('diamond', p.radiusPx, 'fill')[0]?.color).toBe(p.fill);
    expect(find('diamond', p.radiusPx, 'stroke')[0]?.color).toBe(p.stroke);
    const d = dotStyles.decode;
    expect(find('circle', d.radiusPx, 'fill')[0]?.color).toBe(d.fill);
    // Preempted is a hollow ring: stroked, never filled.
    const e = dotStyles.preempted;
    expect(find('circle', e.radiusPx, 'stroke')[0]).toMatchObject({
      color: e.stroke,
      lineWidth: 2,
    });
    expect(find('circle', e.radiusPx, 'fill')).toHaveLength(0);
  });

  it('puts waiting requests left of the divider and running ones right of it', () => {
    const s = scene({
      replicas: [
        replica(0, {
          dots: [
            ...dots(12, 'queued'),
            ...dots(2, 'prefill'),
            ...dots(3, 'decode'),
            ...dots(1, 'preempted'),
          ],
        }),
      ],
    });
    const { ctx, layout } = draw(s, { widthPx: 1008, heightPx: 60, dpr: 1 });
    const lane = layout.lanes[0]!;
    const all = dotsIn(ctx, lane).filter((d) => d.op === 'stroke');
    const of = (shape: string, r: number) => all.filter((d) => d.shape === shape && d.r === r);
    const queued = of('circle', 2.5);
    const [preempted] = of('circle', 4.5);
    for (const d of [...queued, preempted!]) expect(d.x).toBeLessThan(lane.batch.x);
    for (const d of [...of('diamond', 4.5), ...of('circle', 4)]) {
      expect(d.x).toBeGreaterThan(lane.queue.x + lane.queue.w);
    }
    // Preempted requests go back to the head of the queue, next to the batch; the queue grows left.
    expect(preempted!.x).toBeGreaterThanOrEqual(Math.max(...queued.map((d) => d.x)));
    expect(Math.min(...queued.map((d) => d.x))).toBeLessThan(preempted!.x);
  });

  it('batches each state into one path per lane', () => {
    const s = scene({ replicas: [replica(0, { dots: dots(50, 'decode') })] });
    const { ctx } = draw(s);
    const decodeFills = ctx.ops.filter(
      (o) => o.op === 'fill' && o.fillStyle === dotStyles.decode.fill,
    );
    expect(decodeFills).toHaveLength(1);
    expect(decodeFills[0]!.op === 'fill' && decodeFills[0]!.path).toHaveLength(50);
  });

  it('grows blocks with their counts, so lanes compare like bars', () => {
    const s = scene({
      replicas: [
        replica(0, { dots: dots(10, 'decode') }),
        replica(1, { dots: dots(40, 'decode') }),
      ],
    });
    const { ctx, layout } = draw(s);
    const extent = (r: number) =>
      Math.max(...dotsIn(ctx, layout.lanes[r]!).map((d) => d.x)) - layout.lanes[r]!.batch.x;
    expect(extent(1)).toBeGreaterThan(extent(0) * 3);
  });

  it('squeezes, then folds the rest into "+N", when a lane overflows', () => {
    const s = scene({
      replicas: [...Array(8).keys()].map((r) =>
        replica(r, { dots: r === 3 ? dots(400, 'queued') : [] }),
      ),
    });
    const { ctx, layout, hits } = draw(s);
    const lane = layout.lanes[3]!;
    const drawn = dotsIn(ctx, lane).filter((d) => d.op === 'stroke').length;
    const label = texts(ctx).find((t) => t.startsWith('+'));
    expect(label).toBeDefined();
    expect(drawn + Number(label!.slice(1))).toBe(400);
    expect(hits.count).toBe(drawn);
    // Squeezed dots still stay inside the queue area.
    for (const d of dotsIn(ctx, lane)) expect(d.x).toBeGreaterThanOrEqual(lane.queue.x);
  });

  it('draws requests waiting at the router inside the router box', () => {
    const s = scene({ router: { atRouter: dots(3, 'queued'), offeredPerS: 2 } });
    const { ctx, layout } = draw(s);
    expect(dotsIn(ctx, layout.router).filter((d) => d.op === 'stroke')).toHaveLength(3);
    expect(texts(ctx)).toContain('2.0 req/s');
  });
});

describe('drawScene: aggregate mode', () => {
  const s = scene({
    detail: 'aggregate',
    replicas: [
      replica(0, {
        prefillTokensPerS: 4000,
        decodeTokensPerS: 800,
        waiting: 12,
        dots: dots(5, 'decode'),
      }),
      replica(1, { prefillTokensPerS: 2000, decodeTokensPerS: 400, waiting: 0 }),
    ],
  });
  const { ctx, layout, hits } = draw(s);

  it('hides dots', () => {
    for (const lane of layout.lanes) {
      expect(dotsIn(ctx, lane).filter((d) => d.r >= 2.5 && d.r !== 3 && d.r !== 3.5)).toHaveLength(
        0,
      );
    }
    expect(hits.count).toBe(0);
  });

  it('shows prefill and decode tokens/s as bars on a shared scale, with rates', () => {
    const bar = (lane: LaneLayout, color: string) =>
      ctx.ops.find(
        (o): o is PathOp =>
          o.op === 'fill' &&
          o.fillStyle === color &&
          o.path.length === 1 &&
          bbox(o.path).w > 10 && // not the glyph at the bar's start
          inRect(bbox(o.path).x, bbox(o.path).y, lane),
      )!;
    const p0 = bbox(bar(layout.lanes[0]!, dotStyles.prefill.fill!).path).w;
    const p1 = bbox(bar(layout.lanes[1]!, dotStyles.prefill.fill!).path).w;
    expect(p1 / p0).toBeCloseTo(0.5, 2);
    const d0 = bbox(bar(layout.lanes[0]!, dotStyles.decode.fill!).path).w;
    expect(d0).toBeGreaterThan(0);
    expect(texts(ctx)).toEqual(expect.arrayContaining(['4.0k tok/s', '800 tok/s', '2.0k tok/s']));
  });

  it('shows queue depth as a bar growing left from the divider', () => {
    const lane = layout.lanes[0]!;
    const q = ctx.ops.find(
      (o): o is PathOp =>
        o.op === 'stroke' &&
        o.strokeStyle === dotStyles.queued.stroke &&
        inRect(bbox(o.path).x, lane.cy, lane),
    );
    const b = bbox(q!.path);
    // The stroke sits half its width inside the box.
    expect(Math.abs(b.x + b.w - (lane.queue.x + lane.queue.w))).toBeLessThanOrEqual(1);
    expect(Math.abs(b.w - Math.ceil(12 / lane.rows) * 10)).toBeLessThanOrEqual(1.5);
  });

  it('keeps nice scales', () => {
    expect([0, 1, 1.5, 3, 7, 4000, 12_000].map(niceCeil)).toEqual([0, 1, 2, 5, 10, 5000, 20_000]);
  });
});

describe('drawScene: tracked analyst', () => {
  function trackedScene(requests: Parameters<typeof turn>[0][], trackedDot = true): SceneState {
    return scene({
      replicas: [0, 1, 2, 3].map((r) =>
        replica(r, {
          dots: [
            ...dots(5, 'decode'),
            ...(r === 2 && trackedDot ? dots(1, 'decode', 77, true) : []),
          ],
        }),
      ),
      tracked: { analyst: 77, requests: requests.map(turn) },
    });
  }

  function paths(ctx: RecordingContext, layout: SceneLayout, color: string, lineWidth: number) {
    const x0 = layout.router.x + layout.router.w;
    return ctx.ops.filter(
      (o): o is PathOp =>
        o.op === 'stroke' &&
        o.strokeStyle === color &&
        o.lineWidth === lineWidth &&
        bbox(o.path).x === x0,
    );
  }

  it('halos the tracked analyst’s dots', () => {
    const { ctx, layout } = draw(trackedScene([{ turn: 1, replica: 2 }]));
    const r = dotStyles.decode.radiusPx + trackedStyle.haloGapPx + trackedStyle.haloWidthPx / 2;
    const halo = dotsIn(ctx, layout.lanes[2]!).find(
      (s) => s.op === 'stroke' && s.r === r && s.color === trackedStyle.haloStroke,
    );
    expect(halo).toBeDefined();
    const dot = dotsIn(ctx, layout.lanes[2]!).find(
      (s) => s.op === 'fill' && s.x === halo!.x && s.y === halo!.y,
    );
    expect(dot?.color).toBe(dotStyles.decode.fill);
  });

  it('traces the latest turn from the router to its replica, labeled with TTFT', () => {
    const { ctx, layout } = draw(trackedScene([{ turn: 1, replica: 2, ttftMs: 420 }]));
    const [path] = paths(ctx, layout, trackedStyle.haloStroke, 2);
    expect(bbox(path!.path).y).toBe(Math.round(layout.lanes[2]!.cy));
    expect(texts(ctx)).toContain('420 ms');
    expect(texts(ctx)).not.toContain('moved');
    expect(texts(ctx)).toContain('T1 R3 420 ms');
    expect(texts(ctx)).toContain('Analyst 77');
  });

  it('marks a turn that moved replica, with the previous turn faded', () => {
    const { ctx, layout } = draw(
      trackedScene([
        { turn: 1, replica: 0, ttftMs: 300 },
        { turn: 2, replica: 2, ttftMs: 1200, moved: true, state: 'decode' },
      ]),
    );
    expect(texts(ctx)).toContain('moved');
    expect(texts(ctx)).toContain('T2 R1→R3 1.2 s');
    const faded = paths(ctx, layout, colors['ink-subtle'], 1.25)[0]!;
    expect(faded.dash).toEqual([3, 2]);
    expect(bbox(faded.path).y).toBe(Math.round(layout.lanes[0]!.cy));
    // The bracket runs from the previous lane to the current one.
    const bracket = ctx.ops.find(
      (o): o is PathOp =>
        o.op === 'stroke' &&
        o.lineWidth === 1.5 &&
        o.strokeStyle === trackedStyle.haloStroke &&
        bbox(o.path).w === 0,
    );
    const b = bbox(bracket!.path);
    expect(b.y).toBe(Math.round(layout.lanes[0]!.cy));
    expect(b.y + b.h).toBeGreaterThan(layout.lanes[1]!.cy);
  });

  it('does not mark the first turn of a new session as moved', () => {
    const { ctx } = draw(
      trackedScene([
        { turn: 3, replica: 0 },
        { turn: 1, replica: 2, moved: false },
      ]),
    );
    expect(texts(ctx)).not.toContain('moved');
    expect(texts(ctx)).toContain('T1 R3 420 ms');
  });

  it('labels turns without a first token by state or outcome', () => {
    const { ctx } = draw(
      trackedScene([
        { turn: 1, replica: 1, ttftMs: null, state: 'timedOut' },
        { turn: 2, replica: null, ttftMs: null, state: 'rejected' },
        { turn: 3, replica: 2, ttftMs: null, state: 'prefill' },
      ]),
    );
    expect(texts(ctx)).toEqual(
      expect.arrayContaining(['T1 R2 timed out', 'T2 router rejected', 'T3 R3 prefill', 'prefill']),
    );
  });

  it('shows a hint when nobody is tracked, and nothing tracked on lanes', () => {
    const { ctx } = draw(scene({ replicas: [replica(0, { dots: dots(3, 'decode') })] }));
    expect(texts(ctx)).toContain('Click a dot to track');
    expect(shapes(ctx).some((s) => s.color === trackedStyle.haloStroke && s.r > 6)).toBe(false);
  });
});

describe('drawScene: High side', () => {
  const s: SceneState = {
    ...statesScene,
    mode: 'highSide',
    detail: 'aggregate',
    tracked: { analyst: 77, requests: [turn({ turn: 1, replica: 2 })] },
    router: { atRouter: dots(2, 'queued'), offeredPerS: 9 },
  };
  const { ctx, layout, hits } = draw(s);

  it('keeps only replica outlines, quiet links, and a no-telemetry note', () => {
    for (const lane of layout.lanes) {
      expect(outline(ctx, lane)).toMatchObject({
        strokeStyle: colors['high-side-outline'],
        dash: [],
      });
    }
    expect(texts(ctx)).toContain(HIGH_SIDE_NOTE);
    expect(texts(ctx)).toContain('Router');
  });

  it('hides tanks, dots, numbers, state, and the tracked analyst', () => {
    expect(shapes(ctx)).toHaveLength(0);
    expect(
      ctx.ops.some((o) => 'fillStyle' in o && o.op === 'fillRect' && o.fillStyle === colors.kv),
    ).toBe(false);
    expect(ctx.ops.some((o) => o.op === 'fill' && o.fillStyle === colors['kv-track'])).toBe(false);
    const t = texts(ctx);
    for (const hidden of ['KV 50%', 'Crashed', 'Down', 'Analyst 77', '9.0 req/s']) {
      expect(t).not.toContain(hidden);
    }
    expect(t.some((x) => x.startsWith('Loading'))).toBe(false);
    expect(hits.count).toBe(0);
  });
});

describe('drawScene: router box text', () => {
  type TextOp = Extract<DrawOp, { text: string }>;
  const fontPx = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  // Mirrors the recording context's measureText: 0.6 em per character.
  const width = (o: TextOp) => o.text.length * fontPx(o.font) * 0.6;
  const right = (o: TextOp) =>
    o.textAlign === 'right' ? o.x : o.textAlign === 'center' ? o.x + width(o) / 2 : o.x + width(o);

  function longScene(replicas: number, tracked: boolean): SceneState {
    return scene({
      router: { atRouter: dots(40, 'queued'), offeredPerS: 1234.5 },
      replicas: Array.from({ length: replicas }, (_, r) => replica(r)),
      tracked: tracked
        ? {
            analyst: 123456,
            requests: [
              turn({ turn: 11, replica: 1, ttftMs: 12_345, tpotMs: 123 }),
              turn({ turn: 12, replica: replicas - 1, moved: true, ttftMs: 2_400, tpotMs: 20 }),
              turn({ turn: 13, replica: null, ttftMs: null, state: 'timedOut' }),
            ],
          }
        : null,
    });
  }

  it.each([
    [360, 1],
    [640, 2],
    [800, 8],
    [1008, 4],
    [1008, 16],
    [1440, 3],
  ])('keeps every label inside the box at %i px with %i replicas', (widthPx, n) => {
    for (const tracked of [true, false]) {
      const { ctx, layout } = draw(longScene(n, tracked), { widthPx, heightPx: 271, dpr: 1 });
      const r = layout.router;
      const inside = ctx.ops.filter(
        (o): o is TextOp => o.op === 'fillText' && o.x >= r.x && o.x < r.x + r.w && o.y < r.y + r.h,
      );
      expect(inside.length).toBeGreaterThan(tracked ? 4 : 2);
      for (const o of inside) expect(right(o), o.text).toBeLessThanOrEqual(r.x + r.w - 4);
    }
  });

  it('drops ms/tok first, then shortens, then truncates', () => {
    const reqs = [
      turn({ turn: 11, replica: 1 }),
      turn({ turn: 12, replica: 7, moved: true, ttftMs: 2_400, tpotMs: 20 }),
    ];
    const ctx = createRecordingContext();
    // Mono 11 px measures 6.6 px per character here.
    const fit = (w: number) => fitText(ctx, turnLines(reqs, 1), w, canvasFonts.numeric);
    expect(fit(180)).toBe('T12 R2→R8 2.4 s · 20 ms/tok');
    expect(fit(100)).toBe('T12 R2→R8 2.4 s');
    expect(fit(95)).toBe('T12 R2→R8 2.4s');
    expect(fit(80)).toBe('T12 R8 2.4s');
    expect(fit(50)).toBe('T12 R8…');
    expect(fit(5)).toBe('');
  });
});
