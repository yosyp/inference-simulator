import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, simMs } from '../engine/time.ts';
import {
  canZoomIn,
  canZoomOut,
  resolveWindow,
  shiftWindow,
  timeTicks,
  windowLabel,
  zoomIn,
  zoomOut,
  zoomSpans,
  type ChartView,
} from './time-window.ts';

const SHIFT = { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS };

describe('chart window', () => {
  it("defaults to the playhead's shift day and follows the playhead to the next day", () => {
    expect(resolveWindow(null, simMs(2, 10, 30), SHIFT)).toEqual({
      fromMs: simMs(2, 7),
      toMs: simMs(2, 17),
    });
    expect(resolveWindow(null, simMs(3, 7), SHIFT)).toEqual({
      fromMs: simMs(3, 7),
      toMs: simMs(3, 17),
    });
    expect(windowLabel(shiftWindow(simMs(2, 12), SHIFT))).toBe('Wed 07:00–17:00');
  });

  it('zooms in one step at a time around the focus, keeping it at the same pixel', () => {
    const t = simMs(2, 10, 30);
    const day = resolveWindow(null, t, SHIFT);
    const v1 = zoomIn(null, day, t, SHIFT)!;
    expect(v1.spanMs).toBe(4 * HOUR_MS);
    const w1 = resolveWindow(v1, t, SHIFT);
    const rel = (t - day.fromMs) / (day.toMs - day.fromMs);
    expect((t - w1.fromMs) / (w1.toMs - w1.fromMs)).toBeCloseTo(rel, 9);
    const spans = [v1.spanMs];
    let v: ChartView | null = v1;
    for (let i = 0; i < 6; i++) {
      v = zoomIn(v, resolveWindow(v, t, SHIFT), t, SHIFT);
      spans.push(v!.spanMs);
    }
    expect(spans).toEqual([4, 2, 1, 0.5, 0.25, 0.25, 0.25].map((h) => h * HOUR_MS));
    expect(canZoomIn(resolveWindow(v, t, SHIFT), SHIFT)).toBe(false);
  });

  it('zooms out back to the shift day, which is the default view', () => {
    const t = simMs(2, 10, 30);
    let v: ChartView | null = { spanMs: HOUR_MS, anchorMs: t - 20 * MINUTE_MS };
    v = zoomOut(v, resolveWindow(v, t, SHIFT), t, SHIFT);
    expect(v!.spanMs).toBe(2 * HOUR_MS);
    v = zoomOut(v, resolveWindow(v, t, SHIFT), t, SHIFT);
    v = zoomOut(v, resolveWindow(v, t, SHIFT), t, SHIFT);
    expect(v).toBeNull();
    expect(canZoomOut(v)).toBe(false);
    expect(zoomOut(null, resolveWindow(null, t, SHIFT), t, SHIFT)).toBeNull();
  });

  it('pages forward as the playhead plays, and always contains it', () => {
    const view: ChartView = { spanMs: HOUR_MS, anchorMs: simMs(2, 10) };
    expect(resolveWindow(view, simMs(2, 10, 59), SHIFT)).toEqual({
      fromMs: simMs(2, 10),
      toMs: simMs(2, 11),
    });
    expect(resolveWindow(view, simMs(2, 11), SHIFT)).toEqual({
      fromMs: simMs(2, 11),
      toMs: simMs(2, 12),
    });
    for (let t = simMs(2, 7); t < simMs(2, 17); t += 7 * MINUTE_MS) {
      const w = resolveWindow(view, t, SHIFT);
      expect(w.toMs - w.fromMs).toBe(HOUR_MS);
      expect(t).toBeGreaterThanOrEqual(w.fromMs);
      expect(t).toBeLessThan(w.toMs);
    }
  });

  it('clamps pages inside the shift, including on the next day', () => {
    const view: ChartView = { spanMs: HOUR_MS, anchorMs: simMs(2, 10, 20) };
    expect(resolveWindow(view, simMs(2, 16, 50), SHIFT)).toEqual({
      fromMs: simMs(2, 16),
      toMs: simMs(2, 17),
    });
    expect(resolveWindow(view, simMs(3, 7, 5), SHIFT)).toEqual({
      fromMs: simMs(3, 7),
      toMs: simMs(3, 8),
    });
  });

  it('offers only spans shorter than the shift', () => {
    expect(zoomSpans({ startMs: 8 * HOUR_MS, endMs: 11 * HOUR_MS })).toEqual([
      3 * HOUR_MS,
      2 * HOUR_MS,
      HOUR_MS,
      30 * MINUTE_MS,
      15 * MINUTE_MS,
    ]);
  });

  it('places clock-aligned ticks', () => {
    expect(timeTicks({ fromMs: simMs(2, 7), toMs: simMs(2, 17) }, 11)).toEqual(
      [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((h) => simMs(2, h)),
    );
    expect(timeTicks({ fromMs: simMs(2, 7), toMs: simMs(2, 17) }, 10)).toEqual(
      [8, 10, 12, 14, 16].map((h) => simMs(2, h)),
    );
    const ticks = timeTicks({ fromMs: simMs(2, 10, 7), toMs: simMs(2, 10, 52) }, 10);
    expect(ticks[0]).toBe(simMs(2, 10, 10));
    expect(ticks.every((t) => t % (5 * MINUTE_MS) === 0)).toBe(true);
    expect(ticks.length).toBeLessThanOrEqual(10);
  });
});
