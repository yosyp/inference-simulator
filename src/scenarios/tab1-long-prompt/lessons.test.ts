// Tab 1 lesson assertions (00-build §7.3, K3). Runs Tuesday headless and checks that the long prompt's
// TTFT is far above a normal turn's while its TPOT rises only a little, plus the chart signals the
// sidebar copy quotes. Local helpers stand in for C1's src/scenarios/testing until it lands.

import { describe, expect, it } from 'vitest';
import { calibration } from '../../data/calibration.ts';
import { patchAt } from '../../engine/api.ts';
import { runHeadless } from '../../engine/headless.ts';
import { OUTCOME, replicaSeries, type ResultChunk } from '../../engine/results.ts';
import { SECOND_MS, dayOf, timeOfDayMs } from '../../engine/time.ts';
import { LONG_PROMPT_TOKENS, scenario } from './index.ts';

interface Req {
  analyst: number;
  arriveMs: number;
  promptTokens: number;
  ttftMs: number;
  tpotMs: number;
  outcome: number;
}

function requests(chunks: readonly ResultChunk[]): Req[] {
  const out: Req[] = [];
  for (const c of chunks) {
    const q = c.requests;
    if (q.scope !== 'all') continue;
    for (let i = 0; i < q.count; i++) {
      const first = q.firstTokenMs[i]!;
      const tokens = q.outputTokens[i]!;
      out.push({
        analyst: q.analyst[i]!,
        arriveMs: q.arriveMs[i]!,
        promptTokens: q.promptTokens[i]!,
        ttftMs: first - q.arriveMs[i]!,
        // As the charts define it (src/playback/index/records.ts).
        tpotMs: tokens >= 2 ? (q.endMs[i]! - first) / (tokens - 1) : NaN,
        outcome: q.outcome[i]!,
      });
    }
  }
  return out;
}

function median(xs: readonly number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** GPU 0's scalar buckets over [fromMs, toMs): nvidia-smi and compute utilization, KV %. */
function buckets(chunks: readonly ResultChunk[], fromMs: number, toMs: number) {
  const out: { atMs: number; smi: number; compute: number; kv: number }[] = [];
  const s = replicaSeries(0);
  for (const c of chunks) {
    const b = c.scalars;
    for (let k = 0; k < b.count; k++) {
      const atMs = b.startMs + k * b.bucketMs;
      if (atMs < fromMs || atMs >= toMs) continue;
      const i = k * b.series + s;
      out.push({
        atMs,
        smi: b.data.busyMs[i]! / b.bucketMs,
        compute: b.data.flops[i]! / ((calibration.gpu.peakDenseFp16Flops * b.bucketMs) / 1000),
        kv: b.data.kvUsedFrac[i]!,
      });
    }
  }
  return out;
}

const moment = scenario.lessonMoment.atMs;
// The whole lesson day (about 0.2 s of wall time): the rollup needs the day's end.
const run = runHeadless({
  config: scenario.sim,
  calibration,
  patches: scenario.baselinePatches,
  days: dayOf(moment),
  tracked: scenario.tracked,
});
const day = run.days[0]!;
const all = requests(day.chunks);
const long = all.filter((r) => r.promptTokens === LONG_PROMPT_TOKENS);
const short = all.filter((r) => r.promptTokens !== LONG_PROMPT_TOKENS);
const longReq = long[0]!;
const shortTtftMs = median(short.map((r) => r.ttftMs));
const shortTpotMs = median(short.map((r) => r.tpotMs));

describe('tab 1: long prompt', () => {
  it('opens paused shortly before a Monday-to-Thursday lesson moment (K2, K16, §7.3)', () => {
    const { entry } = scenario;
    expect(dayOf(moment)).toBeLessThanOrEqual(3);
    expect(dayOf(entry.atMs)).toBe(dayOf(moment));
    expect(entry.atMs).toBeLessThan(moment);
    expect(timeOfDayMs(entry.atMs)).toBeGreaterThanOrEqual(scenario.sim.shift.startMs);
    // All tabs: (lesson moment − entry) ÷ default speed ≤ 45 s of wall time.
    expect((moment - entry.atMs) / entry.speed).toBeLessThanOrEqual(45 * SECOND_MS);
    // The baseline week holds the moment, and the trigger re-sends the same prompt (K1).
    expect(scenario.trigger.patch.kind).toBe('event');
    expect(scenario.baselinePatches).toContainEqual(patchAt(scenario.trigger.patch, moment));
  });

  it("sends one long prompt from the tracked analyst, beside that analyst's normal turns", () => {
    expect(run.trackedAnalyst).toBe(0);
    expect(long).toHaveLength(1);
    expect(longReq.arriveMs).toBe(moment);
    expect(longReq.analyst).toBe(run.trackedAnalyst);
    expect(all.every((r) => r.outcome === OUTCOME.finished)).toBe(true);
    // Enough normal turns for a stable median, some of them before the entry point (chart 1).
    expect(short.length).toBeGreaterThanOrEqual(30);
    expect(short.filter((r) => r.arriveMs < scenario.entry.atMs).length).toBeGreaterThanOrEqual(10);
    // The long prompt runs alone: no normal turn arrives while it is in flight.
    const longEndMs = longReq.arriveMs + longReq.ttftMs + 600 * longReq.tpotMs;
    expect(short.some((r) => r.arriveMs >= moment && r.arriveMs < longEndMs)).toBe(false);
  });

  it('TTFT scales with prompt length; TPOT grows only slowly (K3)', () => {
    // Measured: 4,950 ms vs a 23.5 ms median over 43 normal turns (~210×).
    expect(longReq.ttftMs).toBeGreaterThanOrEqual(20 * shortTtftMs);
    // Measured: 20.3 ms vs 17.5 ms (~1.16×). Not constant: the copy says TPOT rises.
    expect(longReq.tpotMs).toBeLessThanOrEqual(1.35 * shortTpotMs);
    expect(longReq.tpotMs).toBeGreaterThanOrEqual(1.08 * shortTpotMs);
    // The copy's numbers: "mostly 20–50 ms", "about 5 s", "about 17 ms to 20 ms".
    expect(shortTtftMs).toBeGreaterThan(10);
    expect(shortTtftMs).toBeLessThan(40);
    expect(longReq.ttftMs).toBeGreaterThan(4_000);
    expect(longReq.ttftMs).toBeLessThan(6_000);
    expect(shortTpotMs).toBeGreaterThan(16);
    expect(shortTpotMs).toBeLessThan(18.5);
    expect(longReq.tpotMs).toBeGreaterThan(19);
    expect(longReq.tpotMs).toBeLessThan(21.5);
  });

  it('shows the KV bump, the nvidia-smi vs. compute gap, and an idle day on the charts', () => {
    const bucketMs = scenario.sim.bucketMs;
    const from = Math.floor(moment / bucketMs) * bucketMs;
    const around = buckets(day.chunks, from, from + 60 * SECOND_MS);
    // Chart 2: "about 23% of the pool while the long prompt runs".
    const kvMax = Math.max(...around.map((b) => b.kv));
    expect(kvMax).toBeGreaterThan(0.2);
    expect(kvMax).toBeLessThan(0.27);
    // Chart 3: a decode-only bucket is 100% busy by nvidia-smi with compute under 1%...
    const decode = around.filter((b) => b.smi > 0.99);
    expect(decode.length).toBeGreaterThanOrEqual(1);
    for (const b of decode) expect(b.compute).toBeLessThan(0.01);
    // ...and only prefill raises compute (half the peak at η_c 0.5, diluted by the bucket).
    expect(Math.max(...around.map((b) => b.compute))).toBeGreaterThan(0.2);
    // High side: "busy about 1% of the shift".
    const rollup = day.rollup!;
    expect(rollup).toHaveLength(1);
    expect(rollup[0]!.meanNvidiaSmiUtil).toBeGreaterThan(0.004);
    expect(rollup[0]!.meanNvidiaSmiUtil).toBeLessThan(0.02);
  });
});
