// Seeded random workloads for cross-checking the scheduler (tests; E10 may reuse the shape). Small
// pools and budgets so KV exhaustion, preemption, chunking, prefix reuse across turns, timeouts,
// cancels, and crashes all happen within a simulated minute or two.

import type { Calibration } from '../calibration.ts';
import { REPLICA_STATE } from '../results.ts';
import { Source, u01 } from '../rng/index.ts';
import { testConfig, withEngine, type Script, type ScriptRequest } from './harness.ts';
import type { SimConfig } from '../api.ts';

/** Keys under Source.oracleWorkload: (E5_KEY, draw index), apart from E10's own layout. */
const E5_KEY = 0xe5;

export interface Workload {
  script: Script;
  cal: Calibration;
  config: SimConfig;
}

function pick<T>(u: number, options: readonly T[]): T {
  return options[Math.min(options.length - 1, Math.floor(u * options.length))]!;
}

export function randomWorkload(seed: number, base: Calibration): Workload {
  let n = 0;
  const u = () => u01(seed, Source.oracleWorkload, E5_KEY, n++);
  const kvPoolTokens = pick(u(), [1_024, 2_048, 4_096, 16_384]);
  const maxNumSeqs = pick(u(), [2, 4, 8, 32, 256]);
  const maxNumBatchedTokens = Math.max(maxNumSeqs, pick(u(), [64, 256, 512, 2_048, 8_192]));
  const systemPromptTokens = pick(u(), [0, 40, 100]);
  const replicas = u() < 0.3 ? 2 : 1;
  const cal = withEngine(base, { kvPoolTokens, blockSize: 16 });
  const config = testConfig({
    replicas,
    engineOverrides: { maxNumSeqs, maxNumBatchedTokens },
    tunable: { systemPromptTokens },
  });
  const maxSequence = Math.floor(kvPoolTokens * 0.8);
  const requests: ScriptRequest[] = [];
  const sessions = 3 + Math.floor(u() * 25);
  for (let session = 0; session < sessions; session++) {
    const turns = 1 + Math.floor(u() * 4);
    let prompt = systemPromptTokens;
    let prev = -1;
    for (let turn = 1; turn <= turns; turn++) {
      const message = 1 + Math.floor(u() ** 2 * Math.min(1_500, kvPoolTokens / 3));
      const output = 1 + Math.floor(u() ** 2 * 300);
      prompt += message;
      if (prompt + output > maxSequence) break;
      const r: ScriptRequest = {
        atMs: prev < 0 ? u() * 60_000 : u() * 5_000,
        replica: replicas === 2 ? session % 2 : 0,
        session,
        turn,
        promptTokens: prompt,
        outputTokens: output,
        systemPromptTokens,
      };
      if (prev >= 0) r.after = prev;
      if (u() < 0.25) r.timeoutMs = 200 + u() * 20_000;
      if (prev < 0 && u() < 0.08) r.cancelAtMs = r.atMs + u() * 30_000;
      prev = requests.length;
      requests.push(r);
      prompt += output;
    }
  }
  const script: Script = { requests };
  if (u() < 0.2) {
    const replica = replicas === 2 ? Math.floor(u() * 2) : 0;
    const at = 5_000 + u() * 60_000;
    script.replicaChanges = [
      { atMs: at, replica, state: REPLICA_STATE.crashed },
      { atMs: at + 500, replica, state: REPLICA_STATE.down },
      { atMs: at + 1_000, replica, state: REPLICA_STATE.loadingWeights },
      { atMs: at + 3_000, replica, state: REPLICA_STATE.initializingEngine },
      { atMs: at + 5_000 + u() * 10_000, replica, state: REPLICA_STATE.ready },
    ];
  }
  return { script, cal, config };
}
