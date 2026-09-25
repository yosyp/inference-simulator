// Tab 1, Long prompt (01 §6, 02 §10, K3). Stage (a): one analyst on one GPU for a work week.
// Lesson: TTFT scales with prompt length; TPOT grows only slowly, because each decode step's memory
// traffic is mostly the 16 GB of weights. The lesson moment is one 32k-token prompt from the tracked
// analyst on Tuesday at 11:00, beside their normal short turns.
//
// Measured on the measured calibration (X4: η_c 0.545, η_b 0.848, t_o 0.71 ms, KV pool 158,864,
// 2,048-token chunks, 18.9 ms per request, 6.2 µs per cached token), lessons.test.ts: the long
// prompt's TTFT is 4.56 s against a normal-turn median of 82 ms (~56×); its TPOT is 16.2 ms against
// 13.5 ms (~1.2×). Normal turns now pay the per-request overhead and ~6 µs for every cached token of
// history, so their TTFT is 40–180 ms and grows as a conversation lengthens (was ~20–50 ms). The
// copy quotes these numbers; the test guards them.

import type { Patch, PatchTemplate, SimConfig } from '../../engine/api.ts';
import { HOUR_MS, simMs } from '../../engine/time.ts';
import type { ReplicaSnapshot } from '../../playback/types.ts';
import type { Scenario } from '../schema.ts';

/** The long prompt: a pasted document of about 24,000 words, answered with a ~600-word summary.
 * 800 output tokens (was 600) keep decode running through a whole 10 s bucket at the faster measured
 * TPOT, so chart 3 shows a decode-only bucket at 100% nvidia-smi. */
export const LONG_PROMPT_TOKENS = 32_000;
export const LONG_PROMPT_OUTPUT_TOKENS = 800;

/** Tuesday 11:00:05, 7 s after the analyst's fifth turn of a conversation finishes (seed 20). */
export const LESSON_MOMENT_MS = simMs(1, 11, 0, 5);
/** 5 minutes before: at 50× that is 6 s of Play, with a normal turn just before the moment. */
export const ENTRY_MS = simMs(1, 10, 55, 5);
/** 50×, like every tab: the charts fill quickly. At 1× the dots and the analyst's wait are legible. */
export const ENTRY_SPEED = 50;

const longPrompt: PatchTemplate = {
  kind: 'event',
  event: {
    type: 'extraRequest',
    analyst: 'tracked',
    promptTokens: LONG_PROMPT_TOKENS,
    outputTokens: LONG_PROMPT_OUTPUT_TOKENS,
  },
};

export const sim: SimConfig = {
  // Seed 20 gives an even week (31–43 turns a day) and, on Tuesday, a long conversation with a quiet
  // 2-minute gap after its fifth turn: the long prompt runs alone, between normal turns.
  seed: 20,
  replicas: 1,
  // Stage (a): one analyst (01 §5, §12 item 1). Analyst 0 is the only one.
  analystsPerReplica: 1,
  shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
  diurnal: {
    knots: [
      [6.5 * HOUR_MS, 0],
      [7 * HOUR_MS, 0.3],
      [10.5 * HOUR_MS, 1],
      [12 * HOUR_MS, 0.7],
      [14.5 * HOUR_MS, 0.9],
      [17 * HOUR_MS, 0],
    ],
    dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
  },
  // A regular user: about 8 conversations a day of ~4 turns, so 30–40 requests on a typical day.
  sessionsPerAnalystPerDay: 8,
  messageTokensSigma: 0.8,
  outputTokensSigma: 0.7,
  outputTokensMax: 4096,
  thinkTimeShape: 3,
  virtualNodesPerReplica: 64,
  routerOverheadMs: 2,
  detectionDelayMs: 10_000,
  coldStart: 'replacementHost',
  engineOverrides: {},
  bucketMs: 10_000,
  histBucketMs: 60_000,
  tunable: {
    loadMultiplier: 1,
    systemPromptTokens: 800,
    turnsPerSessionMean: 4,
    // A typed question: ~150 tokens (~110 words). Earlier turns stay cached, so each normal turn
    // prefills only its new message: TTFT mostly 40–150 ms (per-request overhead plus reading the
    // cached history).
    messageTokensMedian: 150,
    outputTokensMedian: 300,
    thinkTimeMedianMs: 90_000,
    // Well above the long prompt's ~4.6 s TTFT, so it never times out.
    timeoutToFirstTokenMs: 60_000,
    retryPolicy: 'exponential',
    retryBaseMs: 1_000,
    retryCapMs: 30_000,
    maxRetries: 3,
    // Routing and admission do nothing with one replica and one analyst.
    routingPolicy: 'roundRobin',
    hashScheme: 'modN',
    signalRefreshMs: 1_000,
    admissionLimitPerReplica: null,
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
  },
};

const lessonPatch: Patch = { kind: 'event', atMs: LESSON_MOMENT_MS, event: longPrompt.event };

/** "100%", "48%", or "under 1%": decode's compute utilization is a fraction of a percent. */
export function pct(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return '0%';
  if (frac < 0.01) return 'under 1%';
  return `${Math.round(frac * 100)}%`;
}

function gpu(s: { replicas: readonly ReplicaSnapshot[] }): ReplicaSnapshot | null {
  return s.replicas[0] ?? null;
}

export const scenario: Scenario = {
  id: 'long-prompt',
  tab: 1,
  title: 'Long prompt',
  preset: { name: '1 GPU', replicas: 1, basis: 'measured' },
  sim,
  baselinePatches: [lessonPatch],
  lessonMoment: { atMs: LESSON_MOMENT_MS, label: 'The analyst sends a 32k-token prompt' },
  entry: { atMs: ENTRY_MS, speed: ENTRY_SPEED },
  trigger: { label: 'Send a 32k-token prompt', patch: longPrompt },
  tracked: { rule: 'fixed', analyst: 0 },
  lesson: {
    summary: 'One analyst on one GPU sends a 32,000-token prompt among their normal short turns.',
    takeaway:
      'Time to first token grows with prompt length: 4.6 s instead of about 80 ms here. Time per output token barely moves, because each decode step mostly reads the model’s weights, not the prompt.',
  },
  // Two hours around the long prompt: enough normal turns beside it to compare.
  chartWindowMs: 2 * HOUR_MS,
  chart3: 'utilization',
  drawer: [
    {
      param: 'messageTokensMedian',
      label: 'Message length (median)',
      help: 'New tokens the analyst types per turn. Applies to conversations that start later.',
      control: { kind: 'range', min: 50, max: 4_000, step: 50, unit: 'tokens' },
    },
    {
      param: 'outputTokensMedian',
      label: 'Answer length (median)',
      help: 'Tokens the model generates per turn. Applies to conversations that start later.',
      control: { kind: 'range', min: 50, max: 2_000, step: 50, unit: 'tokens' },
    },
  ],
  copy: {
    whatToWatch: [
      'One analyst on one GPU. On Tuesday at 11:00 they paste a 32,000-token document. Their normal turns prefill only a few hundred new tokens each; earlier turns stay in the cache.',
      'Time to first token (TTFT) is prefill: the GPU processes the whole prompt before the first output token. Normal turns wait mostly 40–150 ms, more as the conversation’s cached history grows. The long prompt waits about 4.6 s; switch to 1× just before 11:00 to watch its dot sit in prefill that long. On the latency chart, each dot is one request’s TTFT.',
      'Time per output token (TPOT) rises only from about 13.5 ms to 16 ms. Each decode step reads all 16 GB of weights, plus the KV cache for every token of context. At 32,000 tokens the KV cache is about 4 GB, so each step reads about a quarter more.',
      'The memory chart shows that KV cache: about 21% of the pool while the long prompt runs. On the utilization chart, decode keeps the GPU 100% busy by nvidia-smi while compute stays under 1%: decode waits on memory, not arithmetic. Across the day the GPU is busy under 1% of the shift.',
    ],
    tryThis: [
      'Raise Message length to 4,000 tokens, then play to the next conversation at 12:22. Its turns take 300–450 ms to first token instead of about 40 ms.',
      'Raise Answer length to 1,500 tokens. The next conversation takes longer end to end (the rings on the latency chart), but its TTFT stays near 40–55 ms.',
      'Switch to High side and play to Wednesday 12:00. Tuesday’s rollup arrives: requests served, mean latency, and a GPU busy under 1% of the shift. The long prompt does not show.',
    ],
  },
  // The snapshot's levels (running, KV) are the current 10 s bucket; its rates and utilization are
  // over the trailing minute, so the text says "last minute" wherever it quotes one.
  statusTemplates: [
    {
      // A long prompt: 8k+ prefilled tokens in a minute; normal turns prefill a few hundred.
      id: 'longPrefill',
      priority: 20,
      render: (s) => {
        const r = gpu(s);
        const tokens = r ? r.prefillTokensPerS * 60 : NaN;
        if (!r || !(tokens >= 8_000 && r.running >= 0.5)) return null;
        return `The last minute prefilled about ${Math.round(tokens / 1_000)}k prompt tokens. KV cache at ${pct(r.kvUsedFrac)} of the pool.`;
      },
    },
    {
      id: 'serving',
      priority: 10,
      render: (s) => {
        const r = gpu(s);
        if (!r || !(r.running >= 0.5)) return null;
        return `Serving the analyst. KV cache at ${pct(r.kvUsedFrac)} of the pool; GPU busy ${pct(r.nvidiaSmiUtil)} of the last minute.`;
      },
    },
    {
      id: 'idle',
      priority: 0,
      render: (s) => {
        const r = gpu(s);
        if (!r || !Number.isFinite(r.nvidiaSmiUtil)) return null;
        return `GPU mostly idle while the analyst reads and types: busy ${pct(r.nvidiaSmiUtil)} of the last minute.`;
      },
    },
  ],
};
