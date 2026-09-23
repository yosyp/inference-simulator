import { describe, expect, it } from 'vitest';
import { simMs } from '../engine/time.ts';
import {
  MISSING,
  formatClock,
  formatCount,
  formatDay,
  formatMs,
  formatPercent,
  formatRate,
  formatRatio,
  formatSpan,
  msTickFormat,
  percentTickFormat,
  plainTickFormat,
} from './format.ts';
import { logMsAxis, zeroBasedAxis } from './series.ts';

describe('formatting', () => {
  it('formats latency in ms, s, and min', () => {
    expect(formatMs(4.52)).toBe('4.5 ms');
    expect(formatMs(412.4)).toBe('412 ms');
    expect(formatMs(3_240)).toBe('3.2 s');
    expect(formatMs(3_000)).toBe('3 s');
    expect(formatMs(32_400)).toBe('32 s');
    expect(formatMs(90_000)).toBe('1.5 min');
    expect(formatMs(NaN)).toBe(MISSING);
  });

  it('formats fractions, rates, counts, and ratios', () => {
    expect(formatPercent(0.843)).toBe('84%');
    expect(formatPercent(0.048)).toBe('4.8%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatRate(0.25)).toBe('0.25/s');
    expect(formatRate(3.21)).toBe('3.2/s');
    expect(formatRate(1234.4)).toBe('1,234/s');
    expect(formatCount(3.44)).toBe('3.4');
    expect(formatCount(18)).toBe('18');
    expect(formatCount(1284.2)).toBe('1,284');
    expect(formatRatio(1.84)).toBe('1.8×');
    expect(formatRatio(Infinity)).toBe(MISSING);
  });

  it('formats simulated clock times and spans', () => {
    expect(formatClock(simMs(2, 10, 30, 15))).toBe('10:30');
    expect(formatClock(simMs(2, 10, 30, 15), true)).toBe('10:30:15');
    expect(formatDay(simMs(2, 10))).toBe('Wed');
    expect(formatDay(simMs(4, 23))).toBe('Fri');
    expect(formatSpan(10 * 3_600_000)).toBe('10 h');
    expect(formatSpan(90 * 60_000)).toBe('1 h 30 min');
    expect(formatSpan(15 * 60_000)).toBe('15 min');
  });

  it('labels axes with one unit and minimal decimals', () => {
    const ms = msTickFormat([0, 200, 400]);
    expect([0, 200, 400].map(ms)).toEqual(['0', '200 ms', '400 ms']);
    const s = msTickFormat([0, 500, 1000, 1500]);
    expect([0, 500, 1500].map(s)).toEqual(['0', '0.5 s', '1.5 s']);
    expect(percentTickFormat()(0.5)).toBe('50%');
    expect(plainTickFormat('/s')(2.5)).toBe('2.5/s');
    expect(plainTickFormat()(2000)).toBe('2k');
  });

  it('builds a zero-based axis with nice ticks and a floor', () => {
    const a = zeroBasedAxis(83, 4, () => plainTickFormat());
    expect(a.domain).toEqual([0, 100]);
    expect(a.ticks.map((t) => t.value)).toEqual([0, 50, 100]);
    expect(zeroBasedAxis(NaN, 4, () => plainTickFormat()).domain[1]).toBeGreaterThanOrEqual(4);
  });

  it('builds a log latency axis in whole decades, at least two tall', () => {
    const a = logMsAxis([80, 150, 20_000]);
    expect(a.domain).toEqual([10, 100_000]);
    expect(a.ticks.map((t) => t.label)).toEqual(['10 ms', '100 ms', '1 s', '10 s', '100 s']);
    expect(logMsAxis([120, 180]).domain).toEqual([10, 1000]);
    expect(logMsAxis([]).domain).toEqual([10, 1000]);
    expect(logMsAxis([0.2, 5]).domain[0]).toBe(1);
    // More than five decades: every other tick, keeping the top one.
    expect(logMsAxis([1, 1_000_000]).ticks.map((t) => t.value)).toEqual([
      1, 100, 10_000, 1_000_000,
    ]);
  });
});
