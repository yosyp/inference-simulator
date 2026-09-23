import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../calibration.ts';
import {
  addDecodeSequence,
  addPrefillChunk,
  assertInvariants,
  attentionPairs,
  clearStepDesc,
  emptyStepDesc,
  stepMs,
  stepTime,
  type StepDesc,
} from './step.ts';
import { computeUtilization, nvidiaSmiUtilization } from './utilization.ts';

const cal = parseCalibration(raw);

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
}

describe('attentionPairs', () => {
  it('sums the causal triangle exactly', () => {
    for (const [p, n] of [
      [0, 1],
      [0, 7],
      [5, 1],
      [100, 33],
      [8192, 8192],
    ] as const) {
      let brute = 0;
      for (let i = 1; i <= n; i++) brute += p + i;
      expect(attentionPairs(p, n)).toBe(brute);
    }
  });

  it('does not depend on how a prompt is chunked', () => {
    const n = 50_000;
    for (const chunk of [1_000, 4_096, 8_192, 50_000]) {
      let total = 0;
      for (let p = 0; p < n; p += chunk) total += attentionPairs(p, Math.min(chunk, n - p));
      expect(total).toBe(attentionPairs(0, n));
    }
  });
});

describe('stepTime', () => {
  it('matches the 02 §6 formula written out by hand', () => {
    // One 2,048-token chunk after 1,000 cached tokens, plus 3 decodes attending 500, 1,500, 3,000.
    const desc = emptyStepDesc();
    addPrefillChunk(desc, 1_000, 2_048);
    addDecodeSequence(desc, 500);
    addDecodeSequence(desc, 1_500);
    addDecodeSequence(desc, 3_000);
    assertInvariants(desc);
    const pairs = 2_048 * 1_000 + (2_048 * 2_049) / 2 + 500 + 1_500 + 3_000;
    const flops = 2 * 8.03e9 * (2_048 + 3) + 4 * 32 * 4_096 * pairs;
    const kvRead = 1_000 + 2_048 + 500 + 1_500 + 3_000;
    const kvWritten = 2_048 + 3;
    const bytes = 16.06e9 + 131_072 * (kvRead + kvWritten);
    const computeMs = (flops / (0.5 * 312e12)) * 1000;
    const memoryMs = (bytes / (0.8 * 1_555e9)) * 1000;
    const cost = stepTime(desc, cal);
    expect(cost.flops).toBe(flops);
    expect(cost.bytes).toBe(bytes);
    expect(relErr(cost.computeMs, computeMs)).toBeLessThan(1e-12);
    expect(relErr(cost.memoryMs, memoryMs)).toBeLessThan(1e-12);
    expect(relErr(cost.stepMs, 4 + Math.max(computeMs, memoryMs))).toBeLessThan(1e-12);
    expect(stepMs(desc, cal)).toBe(cost.stepMs);
  });

  it('treats a decode as a one-token prefill chunk', () => {
    for (const c of [1, 17, 4_096, 100_000]) {
      const decode = emptyStepDesc();
      addDecodeSequence(decode, c);
      const chunk = emptyStepDesc();
      addPrefillChunk(chunk, c - 1, 1);
      const a = stepTime(decode, cal);
      const b = stepTime(chunk, cal);
      expect(a).toEqual(b);
    }
  });

  it('reuses the output object and costs zero for an empty step', () => {
    const out = stepTime(emptyStepDesc(), cal);
    expect(out).toEqual({ stepMs: 0, computeMs: 0, memoryMs: 0, flops: 0, bytes: 0 });
    const desc = emptyStepDesc();
    addDecodeSequence(desc, 10);
    expect(stepTime(desc, cal, out)).toBe(out);
    expect(out.stepMs).toBeGreaterThan(cal.costModel.stepOverheadMs);
    clearStepDesc(desc);
    expect(desc).toEqual(emptyStepDesc());
  });

  it('is memory-bound for small decode batches and compute-bound for long prefill chunks', () => {
    const decode = emptyStepDesc();
    for (let i = 0; i < 8; i++) addDecodeSequence(decode, 2_000);
    const d = stepTime(decode, cal);
    expect(d.memoryMs).toBeGreaterThan(d.computeMs);
    const prefill = emptyStepDesc();
    addPrefillChunk(prefill, 0, 2_048);
    const p = stepTime(prefill, cal);
    expect(p.computeMs).toBeGreaterThan(p.memoryMs);
  });
});

describe('assertInvariants', () => {
  it('accepts built descriptors and rejects inconsistent ones', () => {
    const ok = emptyStepDesc();
    assertInvariants(ok);
    addPrefillChunk(ok, 0, 1);
    addPrefillChunk(ok, 300, 20);
    addDecodeSequence(ok, 1);
    assertInvariants(ok);

    const bad: Array<Partial<StepDesc>> = [
      { decodeSeqs: 2, decodeContextTokens: 1 },
      { decodeContextTokens: 5 },
      { prefillPriorTokens: 10 },
      { prefillTokens: 4, prefillPriorTokens: 100, prefillAttentionPairs: 50 },
      { decodeSeqs: -1 },
      { prefillTokens: 1.5, prefillAttentionPairs: 3 },
    ];
    for (const fields of bad) {
      expect(() => assertInvariants({ ...emptyStepDesc(), ...fields })).toThrow(/StepDesc/);
    }
  });
});

describe('utilization', () => {
  it('counts the full step, t_o included, as nvidia-smi-style busy time', () => {
    const desc = emptyStepDesc();
    addDecodeSequence(desc, 1_000);
    const cost = stepTime(desc, cal);
    // Ten back-to-back steps, then idle for as long again.
    expect(nvidiaSmiUtilization(10 * cost.stepMs, 10 * cost.stepMs)).toBe(1);
    expect(nvidiaSmiUtilization(10 * cost.stepMs, 20 * cost.stepMs)).toBe(0.5);
    expect(nvidiaSmiUtilization(0, 0)).toBe(0);
  });

  it('keeps compute utilization below η_c, and far below it when memory-bound', () => {
    const prefill = emptyStepDesc();
    addPrefillChunk(prefill, 0, 8_192);
    const p = stepTime(prefill, cal);
    const pu = computeUtilization(p.flops, p.stepMs, cal);
    const etaC = cal.costModel.computeEfficiency;
    expect(pu).toBeLessThan(etaC);
    expect(relErr(pu, (etaC * p.computeMs) / p.stepMs)).toBeLessThan(1e-12);

    const decode = emptyStepDesc();
    addDecodeSequence(decode, 1_000);
    const d = stepTime(decode, cal);
    expect(computeUtilization(d.flops, d.stepMs, cal)).toBeLessThan(0.01);
    expect(nvidiaSmiUtilization(d.stepMs, d.stepMs)).toBe(1);
    expect(computeUtilization(1e15, 0, cal)).toBe(0);
  });
});
