// Throughput of one replica at knee-level load. Skipped unless E5_BENCH is set:
//   E5_BENCH=1 pnpm vitest run --project node src/engine/replica/bench.test.ts --reporter=verbose
// E5_BENCH_RATE sets session starts per second (default 0.55: about 2.1 requests/s, the knee).
// Vitest's module runner slows cross-module calls 2-3× against the bundled worker (see kv/bench).

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../calibration.ts';
import { OUTCOME } from '../results.ts';
import { Source, exponential, geometric, logLogistic, lognormal, u01 } from '../rng/index.ts';
import { runScript, testConfig, type Script, type ScriptRequest } from './harness.ts';

const cal = parseCalibration(raw);
const KEY = 0xe5b;
const SYSTEM = 800;
const HOUR_MS = 3_600_000;

/** Multi-turn sessions (02 §8 shapes): lognormal lengths, geometric turns, log-logistic think. */
function kneeScript(sessionsPerSecond: number, durationMs: number, seed: number): Script {
  const u = (...k: number[]) => u01(seed, Source.oracleWorkload, KEY, ...k);
  const requests: ScriptRequest[] = [];
  let t = 0;
  for (let session = 0; ; session++) {
    t += exponential(u(session, 0), 1_000 / sessionsPerSecond);
    if (t >= durationMs) break;
    const turns = geometric(u(session, 1), 4);
    let prompt = SYSTEM;
    let prev = -1;
    for (let turn = 1; turn <= turns; turn++) {
      const message = Math.max(1, Math.round(lognormal(u(session, 2, turn), 150, 0.8)));
      const output = Math.min(
        2_048,
        Math.max(1, Math.round(lognormal(u(session, 3, turn), 300, 0.7))),
      );
      prompt += message;
      if (prompt + output > 60_000) break;
      const think = Math.min(20 * 60_000, logLogistic(u(session, 4, turn), 60_000, 3));
      const r: ScriptRequest = {
        atMs: prev < 0 ? t : think,
        session,
        turn,
        promptTokens: prompt,
        outputTokens: output,
        systemPromptTokens: SYSTEM,
      };
      if (prev >= 0) r.after = prev;
      prev = requests.length;
      requests.push(r);
      prompt += output;
    }
  }
  return { requests };
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function bench(eventJumping: boolean, rate: number, hours: number) {
  const script = kneeScript(rate, hours * HOUR_MS, 7);
  const config = testConfig({ tunable: { systemPromptTokens: SYSTEM } });
  let events = 0;
  const h = runScript(cal, script, {
    config,
    eventJumping,
    runner: { trace: () => void events++ },
  });
  const start = process.hrtime.bigint();
  h.run.advance(h.run.dayEndMs);
  const wall = Number(process.hrtime.bigint() - start) / 1e9;
  const d = h.driver();
  const done = d.outcome.filter((o) => o === OUTCOME.finished).length;
  const ttft = d.firstTokenMs.map((f, i) => f - d.dispatchMs[i]!).filter((x) => x >= 0);
  ttft.sort((a, b) => a - b);
  const m = h.run.state.shared.meters.replica;
  // Later turns run past the arrival window: measure over the time the replica had work.
  const lastEndMs = Math.max(...d.endMs) - h.run.state.core.dayStartMs;
  const simSeconds = lastEndMs / 1_000;
  return {
    mode: eventJumping ? 'jumping' : 'per step',
    requests: script.requests.length,
    finished: done,
    requestsPerSecond: +(done / simSeconds).toFixed(2),
    preemptions: m.preemptions[0],
    ttftP50Ms: +quantile(ttft, 0.5).toFixed(1),
    ttftP99Ms: +quantile(ttft, 0.99).toFixed(1),
    busyFrac: +(m.busyMs[0]! / lastEndMs).toFixed(3),
    events,
    wallSeconds: +wall.toFixed(2),
    eventsPerSecond: Math.round(events / wall),
    simSecondsPerWallSecond: Math.round(simSeconds / wall),
  };
}

describe.skipIf(!process.env.E5_BENCH)('replica throughput at knee load', () => {
  it('one replica, one simulated hour of multi-turn sessions', { timeout: 600_000 }, () => {
    const rate = Number(process.env.E5_BENCH_RATE ?? 0.55);
    bench(true, rate, 0.25); // warm-up
    const jump = bench(true, rate, 1);
    const step = bench(false, rate, 1);
    console.info([jump, step]);
    expect(jump.finished).toBe(step.finished);
  });
});
