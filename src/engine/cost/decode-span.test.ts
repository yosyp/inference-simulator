import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration, type Calibration } from '../calibration.ts';
import {
  decodeSpan,
  decodeSpanBusyMs,
  decodeSpanBytes,
  decodeSpanDurationMs,
  decodeSpanFlops,
  decodeSpanStepMs,
  decodeSpanStepsWithin,
  emptyDecodeSpan,
  type DecodeSpan,
} from './decode-span.ts';
import {
  addAdmittedChunk,
  addDecodeSequence,
  emptyStepCost,
  emptyStepDesc,
  stepTime,
} from './step.ts';

const provisional = parseCalibration(raw);

// A small seeded generator for test inputs (mulberry32). Engine randomness goes through
// src/engine/rng; this only picks deterministic test cases.
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function logUniform(rand: () => number, lo: number, hi: number): number {
  return lo * Math.pow(hi / lo, rand());
}

function intBetween(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * A valid Calibration with the hardware, model, and roofline numbers drawn at random.
 * `attentionHeavy` makes attention compute per context token outgrow its KV read, so spans can
 * start memory-bound and turn compute-bound (the reverse of the usual direction).
 */
function randomCalibration(rand: () => number, attentionHeavy: boolean): Calibration {
  const c = structuredClone(raw);
  c.gpu.peakDenseFp16Flops = logUniform(rand, 20e12, 2_000e12);
  c.gpu.memoryBandwidthBytesPerSecond = logUniform(rand, 0.3e12, 5e12);
  c.costModel.computeEfficiency = logUniform(rand, 0.005, attentionHeavy ? 0.05 : 1);
  c.costModel.bandwidthEfficiency = logUniform(rand, 0.1, 1);
  c.costModel.stepOverheadMs = logUniform(rand, 0.05, 20);
  c.model.params = logUniform(rand, 0.3e9, 100e9);
  c.model.weightBytes = 2 * c.model.params;
  c.model.layers = intBetween(rand, 8, 128);
  c.model.hiddenSize = 128 * intBetween(rand, attentionHeavy ? 32 : 8, 128);
  c.model.kvBytesPerToken = 1024 * intBetween(rand, 8, attentionHeavy ? 64 : 1024);
  return parseCalibration(c);
}

/** The reference: step-by-step through stepTime, the way the oracle (E10) ticks. */
function summedLoop(batch: number, context: number, steps: number, cal: Calibration) {
  const desc = emptyStepDesc();
  const cost = emptyStepCost();
  desc.decodeSeqs = batch;
  let ms = 0;
  let flops = 0;
  let bytes = 0;
  for (let j = 0; j < steps; j++) {
    desc.decodeContextTokens = context + j * batch;
    stepTime(desc, cal, cost);
    ms += cost.stepMs;
    flops += cost.flops;
    bytes += cost.bytes;
  }
  return { ms, flops, bytes };
}

function relErr(a: number, b: number): number {
  if (a === b) return 0;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}

/** The largest double below x (x > 0). */
function nextDown(x: number): number {
  const f = new Float64Array([x]);
  const bits = new BigInt64Array(f.buffer);
  bits[0]! -= 1n;
  return f[0]!;
}

interface Case {
  cal: Calibration;
  batch: number;
  context: number;
  steps: number;
  span: DecodeSpan;
}

/**
 * Random batches, contexts, and calibrations. Half the cases aim k at the regime switch so that
 * spans cross it; k = 0 and k = 1 come up by construction.
 */
function randomCases(seed: number, count: number): Case[] {
  const rand = makeRandom(seed);
  const cases: Case[] = [];
  for (let i = 0; i < count; i++) {
    // Attention-heavy cases start memory-bound only with small batches and short contexts.
    const attentionHeavy = i % 4 === 1;
    const cal = i % 4 === 0 ? provisional : randomCalibration(rand, attentionHeavy);
    const batch = Math.round(logUniform(rand, 1, attentionHeavy ? 16 : 512));
    const context = batch + Math.round(logUniform(rand, 1, attentionHeavy ? 5_000 : 200_000));
    const span = decodeSpan(batch, context, cal);
    let steps: number;
    if (i % 10 === 0) steps = i % 20 === 0 ? 0 : 1;
    else if (rand() < 0.5 && span.switchStep < 20_000) {
      steps = intBetween(rand, Math.max(0, span.switchStep - 50), 2 * span.switchStep + 50);
    } else steps = intBetween(rand, 2, 3_000);
    cases.push({ cal, batch, context, steps, span });
  }
  return cases;
}

const CASES = randomCases(20260923, 1_200);

describe('decodeSpan closed forms', () => {
  it('match a summed loop to 1e-9 relative on random inputs', () => {
    const kinds = {
      crossComputeToMemory: 0,
      crossMemoryToCompute: 0,
      startCompute: 0,
      k0: 0,
      k1: 0,
    };
    for (const { cal, batch, context, steps, span } of CASES) {
      const loop = summedLoop(batch, context, steps, cal);
      const where = `B=${batch} C0=${context} k=${steps} switch=${span.switchStep}`;
      expect(relErr(decodeSpanDurationMs(span, steps), loop.ms), where).toBeLessThanOrEqual(1e-9);
      expect(relErr(decodeSpanBusyMs(span, steps), loop.ms), where).toBeLessThanOrEqual(1e-9);
      expect(relErr(decodeSpanFlops(span, steps), loop.flops), where).toBeLessThanOrEqual(1e-9);
      expect(relErr(decodeSpanBytes(span, steps), loop.bytes), where).toBeLessThanOrEqual(1e-9);
      if (steps === 0) kinds.k0++;
      if (steps === 1) kinds.k1++;
      if (span.firstComputeBound) kinds.startCompute++;
      if (span.switchStep < steps) {
        if (span.firstComputeBound) kinds.crossComputeToMemory++;
        else kinds.crossMemoryToCompute++;
      }
    }
    // The random set must exercise every shape the closed form handles.
    expect(kinds.k0).toBeGreaterThan(20);
    expect(kinds.k1).toBeGreaterThan(20);
    expect(kinds.startCompute).toBeGreaterThan(100);
    expect(kinds.crossComputeToMemory).toBeGreaterThan(50);
    expect(kinds.crossMemoryToCompute).toBeGreaterThan(20);
  });

  it('match stepTime for each single step, on both sides of the switch', () => {
    for (const { cal, batch, context, span } of CASES.slice(0, 200)) {
      const desc = emptyStepDesc();
      desc.decodeSeqs = batch;
      const s = span.switchStep;
      const probes = [0, 1, 7, 500];
      if (s < Infinity) probes.push(s - 1, s, s + 1);
      for (const j of probes) {
        desc.decodeContextTokens = context + j * batch;
        const expected = stepTime(desc, cal).stepMs;
        expect(relErr(decodeSpanStepMs(span, j), expected)).toBeLessThanOrEqual(1e-12);
        expect(
          relErr(decodeSpanDurationMs(span, j + 1) - decodeSpanDurationMs(span, j), expected),
        ).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('crosses from compute- to memory-bound for a large batch (provisional calibration)', () => {
    const span = decodeSpan(256, 256 * 100, provisional);
    expect(span.firstComputeBound).toBe(true);
    expect(span.switchStep).toBeGreaterThan(1);
    expect(span.switchStep).toBeLessThan(10_000);
    const desc = emptyStepDesc();
    desc.decodeSeqs = 256;
    desc.decodeContextTokens = 256 * 100 + (span.switchStep - 1) * 256;
    const before = stepTime(desc, provisional);
    desc.decodeContextTokens += 256;
    const after = stepTime(desc, provisional);
    expect(before.computeMs).toBeGreaterThanOrEqual(before.memoryMs);
    expect(after.memoryMs).toBeGreaterThan(after.computeMs);
    const k = 2 * span.switchStep;
    const loop = summedLoop(256, 256 * 100, k, provisional);
    expect(relErr(decodeSpanDurationMs(span, k), loop.ms)).toBeLessThanOrEqual(1e-9);
  });

  it('stays memory-bound at batch 1 on the provisional calibration', () => {
    const span = decodeSpan(1, 1_000, provisional);
    expect(span.firstComputeBound).toBe(false);
    expect(span.switchStep).toBe(Infinity);
  });

  it('writes into a reused output and stays plain data', () => {
    const out = emptyDecodeSpan();
    expect(decodeSpan(4, 400, provisional, out)).toBe(out);
    expect(structuredClone(out)).toEqual(out);
    expect(() => decodeSpan(0, 0, provisional)).toThrow(RangeError);
  });
});

describe('decodeSpanStepsWithin', () => {
  it('is exact at boundaries: D(k) → k, one ulp below → k − 1', () => {
    const rand = makeRandom(7);
    for (const { span, steps } of CASES) {
      const probes = [steps, intBetween(rand, 1, 5_000)];
      const s = span.switchStep;
      if (s < 1e6) probes.push(s - 1, s, s + 1);
      for (const k of probes) {
        if (k < 1) continue;
        const t = decodeSpanDurationMs(span, k);
        expect(decodeSpanStepsWithin(span, t), `k=${k} switch=${s}`).toBe(k);
        expect(decodeSpanStepsWithin(span, nextDown(t)), `k=${k} switch=${s}`).toBe(k - 1);
        const mid = t + decodeSpanStepMs(span, k) / 2;
        expect(decodeSpanStepsWithin(span, mid)).toBe(k);
      }
    }
  });

  it('agrees with a linear scan for random budgets', () => {
    const rand = makeRandom(11);
    for (const { span } of CASES.slice(0, 300)) {
      const horizon = decodeSpanDurationMs(span, 4_000);
      const budget = rand() * horizon;
      let k = 0;
      let elapsed = 0;
      for (;;) {
        const next = elapsed + decodeSpanStepMs(span, k);
        if (next > budget) break;
        elapsed = next;
        k++;
      }
      const got = decodeSpanStepsWithin(span, budget);
      // The scan sums step by step, so allow its rounding to move a boundary by one step.
      expect(Math.abs(got - k)).toBeLessThanOrEqual(1);
      expect(decodeSpanDurationMs(span, got)).toBeLessThanOrEqual(budget);
      expect(decodeSpanDurationMs(span, got + 1)).toBeGreaterThan(budget);
    }
  });

  it('handles empty, negative, tiny, and unbounded budgets', () => {
    const span = decodeSpan(8, 8_000, provisional);
    const first = decodeSpanStepMs(span, 0);
    expect(decodeSpanStepsWithin(span, 0)).toBe(0);
    expect(decodeSpanStepsWithin(span, -1)).toBe(0);
    expect(decodeSpanStepsWithin(span, NaN)).toBe(0);
    expect(decodeSpanStepsWithin(span, first / 2)).toBe(0);
    expect(decodeSpanStepsWithin(span, first)).toBe(1);
    expect(decodeSpanStepsWithin(span, Infinity)).toBe(Infinity);
    expect(decodeSpanDurationMs(span, 0)).toBe(0);
    expect(decodeSpanFlops(span, 0)).toBe(0);
    expect(decodeSpanBytes(span, 0)).toBe(0);
  });

  it('covers a full simulated day of steps', () => {
    const span = decodeSpan(64, 64 * 2_000, provisional);
    const dayMs = 86_400_000;
    const k = decodeSpanStepsWithin(span, dayMs);
    expect(decodeSpanDurationMs(span, k)).toBeLessThanOrEqual(dayMs);
    expect(decodeSpanDurationMs(span, k + 1)).toBeGreaterThan(dayMs);
  });
});

describe('cost terms outside the roofline (X4a)', () => {
  const cal: Calibration = {
    ...provisional,
    costModel: { ...provisional.costModel, decodePerSeqMs: 0.097, cachedTokenMs: 0.0059 },
  };

  it('a step adds decodePerSeqMs per decode sequence and cachedTokenMs per admitted hit', () => {
    const desc = emptyStepDesc();
    addDecodeSequence(desc, 500);
    addDecodeSequence(desc, 900);
    addAdmittedChunk(desc, 4_096, 256);
    const base = stepTime(desc, provisional).stepMs;
    expect(stepTime(desc, cal).stepMs).toBeCloseTo(base + 2 * 0.097 + 4_096 * 0.0059, 9);
    expect(desc.prefillCachedTokens).toBe(4_096);
  });

  it('a span with the per-sequence term still matches its steps exactly', () => {
    const batch = 96;
    const context = 96 * 3_000;
    const span = decodeSpan(batch, context, cal);
    let total = 0;
    for (let j = 0; j < 400; j++) {
      const desc = emptyStepDesc();
      desc.decodeSeqs = batch;
      desc.decodeContextTokens = context + j * batch;
      const ms = stepTime(desc, cal).stepMs;
      expect(decodeSpanStepMs(span, j)).toBeCloseTo(ms, 9);
      total += ms;
    }
    expect(decodeSpanDurationMs(span, 400)).toBeCloseTo(total, 6);
    expect(decodeSpanStepsWithin(span, decodeSpanDurationMs(span, 400))).toBe(400);
  });
});
