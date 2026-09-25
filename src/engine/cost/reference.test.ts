import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.provisional.json';
import { parseCalibration } from '../calibration.ts';
import { batch1TpotMs, batch1TtftMs } from './reference.ts';
import { attentionFlopsPerPair, bytesPerMs, linearFlopsPerToken } from './step.ts';

// Batch-1 reference latencies on the provisional calibration (E3 done-when, K3, 03 open item 3).
const cal = parseCalibration(raw);
const chunk = cal.engine.maxNumBatchedTokens;
const CONTEXTS = [
  { label: '1k', tokens: 1_024 },
  { label: '8k', tokens: 8_192 },
  { label: '32k', tokens: 32_768 },
  { label: '120k', tokens: 122_880 },
];

// Weights-only decode step: what TPOT tends to as context → 0.
const weightsMs = cal.model.weightBytes / bytesPerMs(cal);
const tpotFloorMs = cal.costModel.stepOverheadMs + weightsMs;

const rows = CONTEXTS.map(({ label, tokens }) => {
  const ttftMs = batch1TtftMs(tokens, chunk, cal);
  const tpotMs = batch1TpotMs(tokens, cal);
  const attentionFlops = (attentionFlopsPerPair(cal) * tokens * (tokens + 1)) / 2;
  const linearFlops = linearFlopsPerToken(cal) * tokens;
  return {
    label,
    tokens,
    ttftMs,
    tpotMs,
    tpotGrowth: tpotMs / tpotFloorMs - 1,
    kvReadShare: (cal.model.kvBytesPerToken * tokens) / cal.model.weightBytes,
    attentionShare: attentionFlops / (attentionFlops + linearFlops),
  };
});

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

describe('batch-1 reference latencies (provisional calibration)', () => {
  it('prints the TTFT and TPOT table', () => {
    const header =
      `Batch-1 TTFT and TPOT, ${cal.status} calibration: η_c ${cal.costModel.computeEfficiency}, ` +
      `η_b ${cal.costModel.bandwidthEfficiency}, t_o ${cal.costModel.stepOverheadMs} ms, ` +
      `chunk ${chunk} tokens. TPOT floor (weights only) ${tpotFloorMs.toFixed(2)} ms.`;
    const lines = [
      header,
      '| Context | Tokens | TTFT (ms) | TPOT (ms) | TPOT vs floor | KV read ÷ weights | Attention share of prefill FLOPs |',
      '|---|---:|---:|---:|---:|---:|---:|',
      ...rows.map(
        (r) =>
          `| ${r.label} | ${r.tokens} | ${r.ttftMs.toFixed(1)} | ${r.tpotMs.toFixed(2)} | ` +
          `+${pct(r.tpotGrowth)} | ${pct(r.kvReadShare)} | ${pct(r.attentionShare)} |`,
      ),
    ];
    console.log(lines.join('\n'));
    expect(rows).toHaveLength(4);
  });

  it('matches 02 §6 worked by hand', () => {
    // TPOT at 1k, memory-bound: (16.06e9 + 131,072 × (1,024 read + 1 written)) B
    // ÷ (0.8 × 1,555e9 B/s) = 13.018 ms, plus t_o 4 ms = 17.018 ms.
    expect(rows[0]!.tpotMs).toBeCloseTo(
      4 + ((16.06e9 + 131_072 * 1_025) / (0.8 * 1_555e9)) * 1e3,
      9,
    );
    expect(rows[0]!.tpotMs).toBeCloseTo(17.018, 3);
    // TTFT at 1k: one compute-bound chunk. 2 × 8.03e9 × 1,024 + 4 × 32 × 4,096 × 1,024 × 1,025 / 2
    // = 1.6720e13 FLOPs ÷ (0.5 × 312e12) = 107.18 ms, plus 4 ms = 111.18 ms.
    const flops1k = 2 * 8.03e9 * 1_024 + (4 * 32 * 4_096 * 1_024 * 1_025) / 2;
    expect(rows[0]!.ttftMs).toBeCloseTo(4 + (flops1k / (0.5 * 312e12)) * 1e3, 9);
    expect(rows[0]!.ttftMs).toBeCloseTo(111.18, 2);
    // TTFT at 120k: 15 chunks of 8,192. Linear 2 × 8.03e9 × 122,880 = 1.9734e15 FLOPs; attention
    // 4 × 32 × 4,096 × 122,880 × 122,881 / 2 = 3.9583e15 (chunking does not change the causal sum).
    // 5.9317e15 ÷ 1.56e14 = 38,024 ms, plus 15 × 4 ms = 38,084 ms. Every chunk is compute-bound.
    const n = 122_880;
    const flops120k = 2 * 8.03e9 * n + (4 * 32 * 4_096 * n * (n + 1)) / 2;
    expect(rows[3]!.ttftMs).toBeCloseTo(15 * 4 + (flops120k / (0.5 * 312e12)) * 1e3, 6);
    expect(rows[3]!.ttftMs / 1e3).toBeCloseTo(38.08, 2);
  });

  it('shows K3: TPOT grows by the KV-read share of per-step bytes, damped by t_o', () => {
    for (const r of rows) {
      // Memory-bound at batch 1, so TPOT − floor is exactly the KV bytes over bandwidth:
      // growth = (KV read + written) / weights × weights-time / (t_o + weights-time).
      const kvMs = (cal.model.kvBytesPerToken * (r.tokens + 1)) / bytesPerMs(cal);
      expect(r.tpotGrowth).toBeCloseTo(kvMs / tpotFloorMs, 12);
      // Memory traffic grows by the KV-read share (K3: +6% at 8k, +26% at 32k, ~2× at 120k);
      // TPOT rises a little less because t_o does not grow.
      expect(r.tpotGrowth).toBeLessThan(r.kvReadShare);
      expect(r.tpotGrowth).toBeGreaterThan(r.kvReadShare * (weightsMs / tpotFloorMs) * 0.999);
    }
    const [, k8, k32, k120] = rows;
    expect(k8!.kvReadShare).toBeCloseTo(0.067, 3);
    expect(k32!.kvReadShare).toBeCloseTo(0.267, 3);
    expect(k120!.kvReadShare).toBeCloseTo(1.0, 2);
    // With t_o = 4 ms: roughly +5% at 8k, +20% at 32k, +75% at 120k.
    expect(k8!.tpotGrowth).toBeGreaterThan(0.045);
    expect(k8!.tpotGrowth).toBeLessThan(0.055);
    expect(k32!.tpotGrowth).toBeGreaterThan(0.19);
    expect(k32!.tpotGrowth).toBeLessThan(0.215);
    expect(k120!.tpotGrowth).toBeGreaterThan(0.72);
    expect(k120!.tpotGrowth).toBeLessThan(0.79);
    // Tab 1's assertion (00-build §7.3): a 16–32k prompt's TPOT stays within 1.35× a short one's.
    expect(k32!.tpotMs / rows[0]!.tpotMs).toBeLessThan(1.35);
  });

  it('shows TTFT growing superlinearly from attention', () => {
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      // TTFT per prompt token rises with length.
      expect(cur.ttftMs / cur.tokens).toBeGreaterThan(prev.ttftMs / prev.tokens);
      expect(cur.attentionShare).toBeGreaterThan(prev.attentionShare);
    }
    // 03 open item 3: attention is about a third of prefill FLOPs at 32k and two-thirds at 120k.
    expect(rows[2]!.attentionShare).toBeCloseTo(1 / 3, 1);
    expect(rows[3]!.attentionShare).toBeCloseTo(2 / 3, 1);
    // 120 × the tokens of 1k costs well over 120 × the time.
    expect(rows[3]!.ttftMs / rows[0]!.ttftMs).toBeGreaterThan(2 * (122_880 / 1_024));
  });

  it('counts prefix-cache hits and rejects bad arguments', () => {
    // A warm 30k-token history with a 1k new message costs one chunk, not four.
    const cold = batch1TtftMs(31_000, chunk, cal);
    const warm = batch1TtftMs(31_000, chunk, cal, 30_000);
    expect(warm).toBeLessThan(cold / 10);
    // At most promptTokens − 1 tokens come from cache.
    expect(batch1TtftMs(100, chunk, cal, 100)).toBe(batch1TtftMs(100, chunk, cal, 99));
    expect(() => batch1TtftMs(100, 0, cal)).toThrow(RangeError);
    expect(() => batch1TtftMs(0, chunk, cal)).toThrow(RangeError);
  });
});
