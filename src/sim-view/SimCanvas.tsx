// The simulation canvas (05 §7). It redraws outside React, once per frame from subscribeFrame, with
// the scene at the playhead (its detail follows the speed threshold). React renders only the
// elements: a canvas sized to its container, and a visually hidden text alternative that the frame
// loop keeps current. Clicking a dot tracks that dot's analyst.

import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { sceneAtPlayhead, subscribeFrame } from '../playback/frame.ts';
import type { PlaybackStore, SceneState } from '../playback/types.ts';
import { cx } from '../ui/primitives/util.ts';
import { subscribeTheme } from '../ui/theme/theme-state.ts';
import { describeScene } from './describe.ts';
import { createDrawScratch, drawScene } from './draw-scene.ts';
import { analystAt, createHitBuffer, hitTest, type HitBuffer } from './hit-test.ts';
import type { Ctx } from './paint.ts';

export interface SimCanvasProps {
  store: PlaybackStore;
  /** Accessible name of the canvas. */
  label?: string;
  className?: string;
}

export const SIM_CANVAS_LABEL = 'Simulation: router and replicas';

function devicePixelRatioNow(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

function pointIn(canvas: HTMLCanvasElement, e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function SimCanvas({ store, label = SIM_CANVAS_LABEL, className }: SimCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const descRef = useRef<HTMLParagraphElement>(null);
  const hitsRef = useRef<HitBuffer | null>(null);
  const descId = useId();

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const desc = descRef.current;
    if (!wrap || !canvas || !desc) return;
    const ctx = canvas.getContext('2d') as Ctx | null;
    const hits = createHitBuffer();
    const scratch = createDrawScratch();
    hitsRef.current = hits;
    let widthPx = 0;
    let heightPx = 0;
    let scene: SceneState | null = null;
    let summary = '';

    const paint = () => {
      if (!scene || !ctx || widthPx <= 0 || heightPx <= 0) return;
      const dpr = devicePixelRatioNow();
      const bw = Math.max(1, Math.round(widthPx * dpr));
      const bh = Math.max(1, Math.round(heightPx * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      drawScene(ctx, scene, { widthPx, heightPx, dpr }, { hits, scratch });
    };

    const resize = (w: number, h: number) => {
      if (w === widthPx && h === heightPx) return;
      widthPx = w;
      heightPx = h;
      paint();
    };

    const unsubscribe = subscribeFrame(store, (state, index) => {
      scene = sceneAtPlayhead(state, index);
      paint();
      const next = describeScene(scene);
      if (next !== summary) {
        summary = next;
        desc.textContent = next;
      }
    });

    // Colors are read at draw time, so a theme switch needs only a repaint.
    const unsubscribeTheme = subscribeTheme(paint);

    const rect = wrap.getBoundingClientRect();
    resize(rect.width, rect.height);
    let observer: ResizeObserver | null = null;
    const onWindowResize = () => {
      const r = wrap.getBoundingClientRect();
      resize(r.width, r.height);
    };
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1]?.contentRect;
        if (box) resize(box.width, box.height);
      });
      observer.observe(wrap);
    } else {
      window.addEventListener('resize', onWindowResize);
    }

    return () => {
      unsubscribe();
      unsubscribeTheme();
      observer?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      hitsRef.current = null;
    };
  }, [store]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const hits = hitsRef.current;
    if (!hits) return;
    const p = pointIn(e.currentTarget, e);
    const analyst = analystAt(hits, p.x, p.y);
    if (analyst !== null) store.track(analyst);
  };

  const onPointerMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const hits = hitsRef.current;
    if (!hits) return;
    const p = pointIn(e.currentTarget, e);
    e.currentTarget.style.cursor = hitTest(hits, p.x, p.y) >= 0 ? 'pointer' : '';
  };

  return (
    <div ref={wrapRef} className={cx('relative h-full w-full overflow-hidden', className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        aria-describedby={descId}
        className="absolute inset-0 block h-full w-full"
        onClick={onClick}
        onPointerMove={onPointerMove}
      />
      <p id={descId} ref={descRef} className="sr-only" />
    </div>
  );
}
