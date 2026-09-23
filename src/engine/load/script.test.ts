import { describe, expect, it } from 'vitest';
import { logLogisticMean, lognormalMean } from '../rng/index.ts';
import {
  MAX_RETRIES,
  drawMessageTokens,
  drawOutputTokens,
  drawThinkMs,
  drawTurns,
  fitMessage,
  fitOutput,
  retriesAllowed,
  retryDelayMs,
  sessionSystemPrompt,
} from './script.ts';

const SEED = 5;
const DAY = 3;
const N = 100_000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('session script draws', () => {
  it('turns are geometric with the requested mean', () => {
    for (const mean of [1, 2.5, 6]) {
      let sum = 0;
      for (let s = 0; s < N; s++) sum += drawTurns(SEED, DAY, s, mean);
      expect(sum / N).toBeCloseTo(mean, 1);
    }
    expect(drawTurns(SEED, DAY, 1, 1)).toBe(1);
  });

  it('message and output lengths are lognormal around their medians, outputs capped', () => {
    const msgs: number[] = [];
    const outs: number[] = [];
    for (let s = 0; s < N / 4; s++) {
      for (let turn = 1; turn <= 4; turn++) {
        msgs.push(drawMessageTokens(SEED, DAY, s, turn, 150, 0.8));
        outs.push(drawOutputTokens(SEED, DAY, s, turn, 300, 0.7, 1000));
      }
    }
    expect(median(msgs)).toBeGreaterThan(145);
    expect(median(msgs)).toBeLessThan(155);
    const msgMean = msgs.reduce((a, b) => a + b, 0) / msgs.length;
    expect(msgMean / lognormalMean(150, 0.8)).toBeCloseTo(1, 1);
    expect(median(outs)).toBeGreaterThan(290);
    expect(median(outs)).toBeLessThan(310);
    expect(outs.reduce((a, b) => Math.max(a, b))).toBe(1000);
    expect(msgs.concat(outs).every((x) => x >= 1)).toBe(true);
    expect(msgs.every(Number.isInteger) && outs.every(Number.isInteger)).toBe(true);
  });

  it('think time is log-logistic around its median', () => {
    const xs: number[] = [];
    for (let s = 0; s < N; s++) xs.push(drawThinkMs(SEED, DAY, s, 1 + (s % 3), 90_000, 3));
    expect(median(xs) / 90_000).toBeCloseTo(1, 1);
    const mean = xs.reduce((a, b) => a + b, 0) / N;
    expect(mean / logLogisticMean(90_000, 3)).toBeCloseTo(1, 1);
  });

  it('every draw is a pure function of its key', () => {
    expect(drawMessageTokens(SEED, DAY, 7, 2, 150, 0.8)).toBe(
      drawMessageTokens(SEED, DAY, 7, 2, 150, 0.8),
    );
    expect(drawThinkMs(SEED, DAY, 7, 2, 1, 3)).toBe(drawThinkMs(SEED, DAY, 7, 2, 1, 3));
    const byTurn = new Set<number>();
    for (let turn = 1; turn <= 20; turn++) byTurn.add(drawThinkMs(SEED, DAY, 7, turn, 1, 3));
    expect(byTurn.size).toBe(20);
    expect(drawThinkMs(SEED, DAY, 7, 2, 1, 3)).not.toBe(drawThinkMs(SEED, 4, 7, 2, 1, 3));
  });
});

describe('retry backoff', () => {
  const delay = (policy: Parameters<typeof retryDelayMs>[0], attempt: number, turn = 1) =>
    retryDelayMs(policy, 1_000, 30_000, SEED, DAY, 42, turn, attempt);

  it('immediate, fixed, and exponential', () => {
    expect([0, 1, 2].map((a) => delay('immediate', a))).toEqual([0, 0, 0]);
    expect([0, 1, 2].map((a) => delay('fixed', a))).toEqual([1_000, 1_000, 1_000]);
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => delay('exponential', a))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('full jitter is a keyed uniform below the exponential cap', () => {
    const xs: number[] = [];
    for (let turn = 1; turn <= 20_000; turn++) {
      const d = delay('fullJitter', 2, turn);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(4_000);
      xs.push(d);
    }
    expect(xs.reduce((a, b) => a + b, 0) / xs.length / 2_000).toBeCloseTo(1, 1);
    expect(delay('fullJitter', 2, 9)).toBe(delay('fullJitter', 2, 9));
    expect(delay('fullJitter', 2, 9)).not.toBe(delay('fullJitter', 3, 9));
    expect(delay('fullJitter', 9, 9)).toBeLessThan(30_000);
  });

  it('retries allowed follow the policy and the attempt field width', () => {
    expect(retriesAllowed('none', 5)).toBe(0);
    expect(retriesAllowed('immediate', 5)).toBe(5);
    expect(retriesAllowed('fixed', 0)).toBe(0);
    expect(retriesAllowed('fixed', 1_000)).toBe(MAX_RETRIES);
  });
});

describe('context bounds', () => {
  it('fits the message and output within maxModelLen', () => {
    expect(sessionSystemPrompt(800, 131_072)).toBe(800);
    expect(sessionSystemPrompt(5_000, 1_000)).toBe(998);
    expect(fitMessage(1_000, 800, 0, 150)).toBe(150);
    expect(fitMessage(1_000, 800, 100, 150)).toBe(99);
    expect(fitMessage(1_000, 800, 199, 150)).toBe(0);
    expect(fitOutput(1_000, 900, 300)).toBe(100);
    expect(fitOutput(1_000, 999, 300)).toBe(1);
    expect(fitOutput(131_072, 900, 300)).toBe(300);
  });
});
