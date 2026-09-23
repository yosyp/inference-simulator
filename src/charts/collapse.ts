// The Live ↔ High-side collapse (05 §9, K13). A progress value p runs 0 (Live) → 1 (High side) on
// d3-timer, and d3-interpolate tweens chart data with it: the window's x domain widens to the week,
// live values flatten to their mean and fade, and the daily bars grow in. React renders every frame;
// d3 never touches the DOM. Under prefers-reduced-motion the switch is instant.

import { interpolateNumber, interpolateNumberArray } from 'd3-interpolate';
import { timer as d3Timer, type Timer } from 'd3-timer';
import { useEffect, useRef, useState } from 'react';
import { WEEK_MS } from '../engine/time.ts';
import type { TimeWindow } from '../playback/types.ts';

export const COLLAPSE_DURATION_MS = 600;

/** d3-timer's timer, injectable for tests. */
export type TimerFn = (callback: (elapsedMs: number) => void) => Pick<Timer, 'stop'>;

/** Cubic in-out, so the collapse starts and lands gently. */
export function easeCubicInOut(k: number): number {
  const t = Math.min(1, Math.max(0, k));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Progress toward `target` (0 Live, 1 High side). Starts at the target on mount, tweens on changes
 * (from wherever an interrupted tween stopped), and returns the target at once under reduced motion.
 */
export function useCollapseProgress(
  target: 0 | 1,
  reducedMotion: boolean,
  durationMs = COLLAPSE_DURATION_MS,
  timer: TimerFn = d3Timer,
): number {
  const [progress, setProgress] = useState<number>(target);
  const current = useRef<number>(target);

  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const duration = reducedMotion ? 0 : durationMs;
    const lerp = interpolateNumber(from, target);
    const t = timer((elapsed) => {
      const k = duration > 0 ? Math.min(1, elapsed / duration) : 1;
      const p = k >= 1 ? target : lerp(easeCubicInOut(k));
      current.current = p;
      setProgress(p);
      if (k >= 1) t.stop();
    });
    return () => t.stop();
  }, [target, reducedMotion, durationMs, timer]);

  return reducedMotion ? target : progress;
}

export interface CollapsePhases {
  /** 0..1: the window widening to the week, and live values flattening to their mean. */
  morph: number;
  /** Opacity of the live chrome: legend, y ticks, gridlines, markers, clock ticks. */
  liveChrome: number;
  /** Opacity of the live lines and points. */
  liveData: number;
  /** Opacity of the High-side layer, and the daily bars' growth. */
  highSide: number;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Staging of the collapse at progress p, so the two views never overlap as text: the live chrome
 * fades out first (by 0.3); the lines squeeze into their day and flatten (0–0.6) and fade (0.5–0.8);
 * the High-side layer fades in and its bars grow (0.4–1). Going back to Live runs it in reverse.
 */
export function collapsePhases(p: number): CollapsePhases {
  return {
    morph: clamp01(p / 0.6),
    liveChrome: clamp01(1 - p / 0.3),
    liveData: clamp01((0.8 - p) / 0.3),
    highSide: clamp01((p - 0.4) / 0.6),
  };
}

/** The x domain at progress p: the live window widening to the whole week. */
export function collapseDomain(window: TimeWindow, p: number): [number, number] {
  if (p <= 0) return [window.fromMs, window.toMs];
  const [from, to] = interpolateNumberArray(
    [window.fromMs, window.toMs],
    [0, WEEK_MS],
  )(Math.min(1, p));
  return [from!, to!];
}
