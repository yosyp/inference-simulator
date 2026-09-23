// The Live ↔ High-side collapse (K13): tweened over data with d3-interpolate on a d3-timer, and
// instant under reduced motion (K18).
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WEEK_MS, simMs } from '../engine/time.ts';
import {
  COLLAPSE_DURATION_MS,
  collapseDomain,
  collapsePhases,
  easeCubicInOut,
  useCollapseProgress,
  type TimerFn,
} from './collapse.ts';
import { flattenToward } from './LineChart.tsx';

/** A d3-timer stand-in driven by hand. */
function manualTimer() {
  const running = new Set<(elapsed: number) => void>();
  const timer: TimerFn = (cb) => {
    running.add(cb);
    return { stop: () => running.delete(cb) };
  };
  return {
    timer,
    get active() {
      return running.size;
    },
    tick(elapsed: number) {
      act(() => {
        for (const cb of [...running]) cb(elapsed);
      });
    },
  };
}

describe('collapse progress', () => {
  it('starts at the current mode without animating', () => {
    const m = manualTimer();
    const { result } = renderHook(() =>
      useCollapseProgress(1, false, COLLAPSE_DURATION_MS, m.timer),
    );
    expect(result.current).toBe(1);
    expect(m.active).toBe(0);
  });

  it('tweens toward the new mode and stops at the end', () => {
    const m = manualTimer();
    const { result, rerender } = renderHook(
      ({ target }) => useCollapseProgress(target, false, 600, m.timer),
      {
        initialProps: { target: 0 as 0 | 1 },
      },
    );
    rerender({ target: 1 });
    expect(m.active).toBe(1);
    const seen: number[] = [];
    for (const t of [0, 150, 300, 450]) {
      m.tick(t);
      seen.push(result.current);
    }
    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(seen[2]).toBeCloseTo(0.5, 9);
    m.tick(600);
    expect(result.current).toBe(1);
    expect(m.active).toBe(0);
  });

  it('reverses from wherever an interrupted tween stopped', () => {
    const m = manualTimer();
    const { result, rerender } = renderHook(
      ({ target }) => useCollapseProgress(target, false, 600, m.timer),
      {
        initialProps: { target: 0 as 0 | 1 },
      },
    );
    rerender({ target: 1 });
    m.tick(300);
    const mid = result.current;
    rerender({ target: 0 });
    expect(m.active).toBe(1);
    m.tick(0);
    expect(result.current).toBeCloseTo(mid, 9);
    m.tick(600);
    expect(result.current).toBe(0);
  });

  it('is instant under reduced motion', () => {
    const m = manualTimer();
    const { result, rerender } = renderHook(
      ({ target }) => useCollapseProgress(target, true, 600, m.timer),
      {
        initialProps: { target: 0 as 0 | 1 },
      },
    );
    rerender({ target: 1 });
    // No frame has run, and the chart already shows the High side.
    expect(result.current).toBe(1);
    m.tick(0);
    expect(result.current).toBe(1);
    expect(m.active).toBe(0);
  });

  it('eases in and out', () => {
    expect(easeCubicInOut(0)).toBe(0);
    expect(easeCubicInOut(0.5)).toBe(0.5);
    expect(easeCubicInOut(1)).toBe(1);
    expect(easeCubicInOut(0.1)).toBeLessThan(0.1);
  });
});

describe('collapse data', () => {
  it('stages the collapse so text never overlaps: live chrome out, lines squeeze, bars in', () => {
    expect(collapsePhases(0)).toEqual({ morph: 0, liveChrome: 1, liveData: 1, highSide: 0 });
    expect(collapsePhases(1)).toEqual({ morph: 1, liveChrome: 0, liveData: 0, highSide: 1 });
    for (let p = 0; p <= 1; p += 0.05) {
      const s = collapsePhases(p);
      // The live legend is gone before the High-side one starts to show.
      expect(s.liveChrome === 0 || s.highSide === 0).toBe(true);
    }
    const mid = collapsePhases(0.6);
    expect(mid.morph).toBe(1);
    expect(mid.liveData).toBeGreaterThan(0);
    expect(mid.highSide).toBeGreaterThan(0);
  });

  it('widens the window to the week', () => {
    const w = { fromMs: simMs(2, 7), toMs: simMs(2, 17) };
    expect(collapseDomain(w, 0)).toEqual([w.fromMs, w.toMs]);
    expect(collapseDomain(w, 1)).toEqual([0, WEEK_MS]);
    const [a, b] = collapseDomain(w, 0.5);
    expect(a).toBeCloseTo(w.fromMs / 2, 6);
    expect(b).toBeCloseTo((w.toMs + WEEK_MS) / 2, 6);
  });

  it('flattens values toward their mean and keeps gaps', () => {
    const v = Float64Array.from([0, 10, NaN, 20]);
    expect(flattenToward(v, 0)).toBe(v);
    expect(Array.from(flattenToward(v, 1))).toEqual([10, 10, NaN, 10]);
    expect(Array.from(flattenToward(v, 0.5))).toEqual([5, 10, NaN, 15]);
  });
});
