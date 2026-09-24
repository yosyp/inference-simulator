// Oracle workloads: E5's randomWorkload (small pools and budgets; multi-turn sessions that reuse
// their prefix; KV exhaustion and preemption; timeouts, cancels, and crashes), extended with E10's
// own keyed draws under Source.oracleWorkload, key word E10_KEY (E5 uses 0xe5):
// - About half the seeds run two replicas behind E7's router (E5 draws 30%; E10 promotes some
//   one-replica workloads). kvUtilization is the most likely policy, since its KV signal is read
//   inside E5's spans (the meterSync topic); the other four policies share the rest.
// - Signal refresh from live (0) to 1 s, router overhead from 0 to 12 ms, and sometimes a fleet
//   admission cap (K9), so rejects happen.
// - Some seeds add a burst of single-turn requests (up to 300 requests in all) inside a short
//   window, to fill max_num_seqs and the waiting queue. A few burst requests share hot sessions,
//   so concurrent requests reuse (and race to register) the same prefix blocks.
// - About 10% of seeds run the calibration's own engine (140k-token pool, 256 sequences, 8,192
//   batched tokens) with a burst of long prompts (up to 60k tokens) and outputs (up to 1,000), so
//   long chunked prefills, long decode spans, and a large LRU are covered too.
// - Some seeds run on Friday rather than Monday, so absolute times are large.
// - About half the seeds turn on the cost terms outside the roofline (X4a): a per-decode-sequence
//   step cost, a per-cached-token cost in the admitting step, and a request overhead between
//   dispatch and scheduling (sometimes equal to the router overhead, so events tie).
// The client's replica choices in randomWorkload are dropped: the router picks.

import type { HashScheme, RoutingPolicy } from '../api.ts';
import type { Calibration } from '../calibration.ts';
import { randomWorkload } from '../replica/workload.ts';
import { Source, u01 } from '../rng/index.ts';
import type { DayIndex } from '../time.ts';
import type { OracleInput, OracleRequestSpec } from './types.ts';

const E10_KEY = 0xe10;
export const MAX_REQUESTS = 300;

/** Draw fields: u01(seed, oracleWorkload, E10_KEY, field, index). */
const F = {
  replicas: 0,
  policy: 1,
  scheme: 2,
  refresh: 3,
  overhead: 4,
  limit: 5,
  limitValue: 6,
  day: 7,
  burst: 8,
  burstSize: 9,
  burstStart: 10,
  burstWindow: 11,
  burstHot: 12,
  burstHotSessions: 13,
  burstOutput: 14,
  lockstep: 15,
  hotPrompt: 16,
  production: 17,
  costTerms: 18,
  requestOverhead: 19,
  at: 20,
  prompt: 21,
  output: 22,
  timeout: 23,
  timeoutMs: 24,
  hot: 25,
  hotSession: 26,
} as const;

function pick<T>(u: number, options: readonly T[]): T {
  return options[Math.min(options.length - 1, Math.floor(u * options.length))]!;
}

const POLICIES: readonly RoutingPolicy[] = [
  'kvUtilization',
  'kvUtilization',
  'kvUtilization',
  'leastOutstanding',
  'roundRobin',
  'sessionAffinity',
  'weighted',
];

export function oracleWorkload(seed: number, base: Calibration): OracleInput {
  const u = (field: number, index = 0) => u01(seed, Source.oracleWorkload, E10_KEY, field, index);
  const w = randomWorkload(seed, base);
  const production = u(F.production) < 0.1;
  const plain = production ? base : w.cal;
  const cal =
    u(F.costTerms) < 0.5
      ? {
          ...plain,
          costModel: {
            ...plain.costModel,
            decodePerSeqMs: 0.097,
            cachedTokenMs: 0.0059,
            requestOverheadMs: pick(u(F.requestOverhead), [0, 1.5, 12, 18.8]),
          },
        }
      : plain;
  const replicas = w.config.replicas === 2 || u(F.replicas) < 0.3 ? 2 : 1;
  const limit = u(F.limit) < 0.2 ? pick(u(F.limitValue), [2, 5, 20]) : null;
  const config = {
    ...w.config,
    seed,
    replicas,
    engineOverrides: production ? {} : w.config.engineOverrides,
    routerOverheadMs: pick(u(F.overhead), [0, 0, 1.5, 12]),
    tunable: {
      ...w.config.tunable,
      routingPolicy: pick(u(F.policy), POLICIES),
      hashScheme: pick<HashScheme>(u(F.scheme), ['modN', 'consistent']),
      signalRefreshMs: pick(u(F.refresh), [0, 20, 250, 1_000]),
      admissionLimitPerReplica: limit,
    },
  };
  const requests: OracleRequestSpec[] = w.script.requests.map((r, i) => ({
    atMs: r.atMs,
    ...(r.after === undefined ? {} : { after: r.after }),
    session: r.session ?? i,
    turn: r.turn ?? 1,
    promptTokens: r.promptTokens,
    outputTokens: r.outputTokens,
    systemPromptTokens: r.systemPromptTokens ?? 0,
    ...(r.timeoutMs === undefined ? {} : { timeoutMs: r.timeoutMs }),
    ...(r.cancelAtMs === undefined ? {} : { cancelAtMs: r.cancelAtMs }),
  }));
  if (production || u(F.burst) < 0.4) {
    addBurst(requests, u, cal.engine.kvPoolTokens, config.tunable, production);
  }
  return {
    seed,
    cal,
    config,
    day: pick<DayIndex>(u(F.day), [0, 0, 0, 0, 4]),
    requests,
    replicaChanges: w.script.replicaChanges ?? [],
  };
}

function addBurst(
  requests: OracleRequestSpec[],
  u: (field: number, index?: number) => number,
  kvPoolTokens: number,
  tunable: { systemPromptTokens: number },
  long: boolean,
): void {
  const room = MAX_REQUESTS - requests.length;
  const size = Math.floor(10 + u(F.burstSize) * (room - 10));
  const start = u(F.burstStart) * 60_000;
  // A window of 0 sends the whole burst at one instant: dispatches share an idle replica's first step.
  const window = pick(u(F.burstWindow), [0, 50, 1_000, 10_000]);
  // Hot sessions run many requests at once over one prefix, so the same blocks are computed,
  // registered, and released side by side; short outputs make finishes coincide.
  const hotShare = pick(u(F.burstHot), [0.1, 0.2, 0.8]);
  const hotSessions = pick(u(F.burstHotSessions), [1, 2, 4]);
  const outputMax = long ? 1_000 : pick(u(F.burstOutput), [8, 40, 250]);
  // In lockstep, a hot session's requests share one prompt length, so they fill the same blocks at
  // the same steps: registration, finish, and release order decide which copy keeps each key.
  const lockstep = u(F.lockstep) < 0.5;
  const system = tunable.systemPromptTokens;
  const maxSequence = Math.floor(kvPoolTokens * 0.8);
  const messageMax = Math.min(long ? 60_000 : 3_000, kvPoolTokens / 2);
  for (let j = 0; j < size; j++) {
    const hot = u(F.hot, j) < hotShare;
    const h = Math.floor(u(F.hotSession, j) * hotSessions);
    const um = hot && lockstep ? u(F.hotPrompt, h) : u(F.prompt, j);
    const message = 1 + Math.floor(um ** 3 * messageMax);
    const promptTokens = Math.min(system + message, maxSequence - 1);
    const output = 1 + Math.floor(u(F.output, j) ** 2 * outputMax);
    const outputTokens = Math.min(output, maxSequence - promptTokens);
    const r: OracleRequestSpec = {
      atMs: start + u(F.at, j) * window,
      session: hot ? 1_000 + h : 2_000 + j,
      turn: 1,
      promptTokens,
      outputTokens,
      systemPromptTokens: system,
    };
    if (u(F.timeout, j) < 0.25) r.timeoutMs = 100 + u(F.timeoutMs, j) * 15_000;
    requests.push(r);
  }
}
