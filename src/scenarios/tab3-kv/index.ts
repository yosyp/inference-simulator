// Tab 3 · KV exhaustion (01 §3 point 3, 02 §10). Stage (b): many analysts on one GPU.
//
// Lesson: the ceiling is memory, not compute. On Wednesday at 10:00 analysts start long drafting
// conversations. Each turn carries the whole history, so KV per request grows turn by turn. The
// pool fills; the scheduler preempts and re-prefills, and returning turns find their history
// evicted and prefill it again. nvidia-smi reads 100% while compute utilization stays low, requests
// served per minute hold level, and TTFT p99 climbs from well under a second to minutes.
//
// The burst of long conversations lasts 30 minutes: a second 'set' at 10:30 restores the everyday
// workload, so the rest of the week stays clean (a lasting 'set' carries into later days). The
// trigger is a lasting 'set' (there is no one-shot workload event yet), so firing it keeps long
// conversations on from the playhead to Friday.

import type { SimConfig, TunableParams } from '../../engine/api.ts';
import { HOUR_MS, simMs } from '../../engine/time.ts';
import type { StatusSnapshot } from '../../playback/types.ts';
import type { Scenario, StatusTemplate } from '../schema.ts';

/** Wednesday, the week's busiest day (dayMultipliers below). */
const DAY = 2;
const MOMENT = simMs(DAY, 10, 0);
/** Sessions starting in [MOMENT, BURST_END) get the long workload. */
const BURST_END = simMs(DAY, 10, 30);

/** The everyday chat workload: short questions, a few turns. */
const EVERYDAY = {
  turnsPerSessionMean: 4,
  messageTokensMedian: 150,
  outputTokensMedian: 300,
} satisfies Partial<TunableParams>;

/**
 * Long drafting conversations: analysts paste source excerpts (~600 tokens, about 450 words) and
 * ask for report sections (~1,200 tokens, about 900 words) over about eight turns. By the eighth
 * turn a conversation's prompt is ~15k tokens, a tenth of the KV pool.
 */
const LONG = {
  turnsPerSessionMean: 8,
  messageTokensMedian: 600,
  outputTokensMedian: 1_200,
} satisfies Partial<TunableParams>;

export const sim: SimConfig = {
  seed: 1,
  replicas: 1,
  // 400 analysts sharing one GPU, three conversations each a day: the GPU is lightly loaded on
  // the everyday workload (KV under 10%, TTFT p99 under half a second).
  analystsPerReplica: 400,
  shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
  diurnal: {
    // A morning peak at 10:30 and a smaller one after lunch.
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
  sessionsPerAnalystPerDay: 3,
  messageTokensSigma: 0.8,
  outputTokensSigma: 0.7,
  outputTokensMax: 4_096,
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
    ...EVERYDAY,
    // Analysts read and type between turns.
    thinkTimeMedianMs: 90_000,
    // The chat client waits for the first token however long it takes, so the lesson shows the
    // queue itself; timeouts and retries are tab 6's lesson.
    timeoutToFirstTokenMs: null,
    retryPolicy: 'exponential',
    retryBaseMs: 1_000,
    retryCapMs: 30_000,
    maxRetries: 3,
    routingPolicy: 'roundRobin',
    hashScheme: 'modN',
    signalRefreshMs: 1_000,
    admissionLimitPerReplica: null,
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
  },
};

const pct = (frac: number) => `${Math.round(frac * 100)}%`;

/** The replica's snapshot, or null while its levels aren't computed. */
function replica(s: StatusSnapshot) {
  const r = s.replicas[0];
  return r && Number.isFinite(r.kvUsedFrac) && Number.isFinite(r.computeUtil) ? r : null;
}

const statusTemplates: StatusTemplate[] = [
  {
    id: 'preempting',
    priority: 30,
    render: (s) => {
      const r = replica(s);
      if (!r || !(r.preemptionsPerMin > 0)) return null;
      return `KV cache at ${pct(r.kvUsedFrac)}: preempting requests to free memory. nvidia-smi ${pct(r.nvidiaSmiUtil)}, compute ${pct(r.computeUtil)}.`;
    },
  },
  {
    id: 'kvFull',
    priority: 20,
    render: (s) => {
      const r = replica(s);
      if (!r || !(r.kvUsedFrac >= 0.85)) return null;
      const waiting = Math.round(r.waiting);
      const queue = waiting > 0 ? `: ${waiting} requests wait for memory` : '';
      return `KV cache at ${pct(r.kvUsedFrac)}${queue}. nvidia-smi ${pct(r.nvidiaSmiUtil)}, compute ${pct(r.computeUtil)}.`;
    },
  },
  {
    id: 'kv',
    priority: 0,
    render: (s) => {
      const r = replica(s);
      if (!r) return null;
      return `KV cache at ${pct(r.kvUsedFrac)}; ${Math.round(r.running)} requests running. Compute ${pct(r.computeUtil)}.`;
    },
  },
];

export const scenario: Scenario = {
  id: 'kv-exhaustion',
  tab: 3,
  title: 'KV exhaustion',
  preset: { name: '1 GPU', replicas: 1, basis: 'measured' },
  sim,
  baselinePatches: [
    { kind: 'set', atMs: MOMENT, changes: LONG },
    { kind: 'set', atMs: BURST_END, changes: EVERYDAY },
  ],
  lessonMoment: { atMs: MOMENT, label: 'Long drafting conversations begin' },
  // Five simulated minutes before the moment. At 50×, KV passes 90% about 35 s after Play.
  entry: { atMs: simMs(DAY, 9, 55), speed: 50 },
  trigger: {
    label: 'Start long conversations',
    patch: { kind: 'set', changes: LONG },
  },
  // An analyst in a conversation that is still going when the pool is full.
  tracked: { rule: 'spansMoment', momentMs: simMs(DAY, 10, 25), minTurnsAfter: 2 },
  chart3: 'utilization',
  drawer: [
    {
      param: 'outputTokensMedian',
      label: 'Output length (median tokens)',
      help: 'Applies to conversations that start after the change.',
      control: { kind: 'range', min: 100, max: 2_000, step: 100 },
    },
    {
      param: 'turnsPerSessionMean',
      label: 'Turns per conversation (mean)',
      help: 'Each turn resends the whole conversation so far.',
      control: { kind: 'range', min: 1, max: 12, step: 1 },
    },
    {
      param: 'messageTokensMedian',
      label: 'Message length (median tokens)',
      control: { kind: 'range', min: 50, max: 2_000, step: 50 },
    },
    {
      param: 'loadMultiplier',
      label: 'Load',
      help: 'Scales how often conversations start.',
      control: { kind: 'range', min: 0.5, max: 1.5, step: 0.1, unit: '×' },
    },
  ],
  copy: {
    whatToWatch: [
      'On Wednesday at 10:00, analysts start long drafting conversations: longer messages, answers of about 1,200 tokens, and about eight turns each. Every turn resends the whole conversation, so each request holds more KV cache than the one before.',
      'Watch the KV tank and chart 2. Within about 25 minutes the pool goes from under 10% to above 90% and touches 100%. The scheduler then preempts running requests, marked as ticks on chart 2, and prefills them again when they get back in.',
      "Chart 3 is where the usual reading goes wrong. nvidia-smi shows 100%, yet compute utilization hovers around 15%. The GPU isn't short of arithmetic; it's short of memory. Most of the prefill it does now is repeat work: conversation history evicted from the cache between turns and computed again.",
      'On chart 1, TTFT p99 lifts first, to a few seconds while the mean is still under one. Once requests queue for memory, both climb to minutes. New conversations are ordinary again from 10:30, and the pool drains by about 11:15.',
    ],
    tryThis: [
      'Pause when KV passes 90% and switch to 5×. Dots turn to the preempted state and go back to the queue.',
      'Just after 10:00, set Turns per conversation to 4 in the drawer. Shorter conversations carry less history, and the pool never stays full.',
      "Switch to High side after Thursday 12:00. Wednesday's bars show a higher mean latency and about 63% utilization, which reads as headroom. KV isn't collected.",
    ],
  },
  statusTemplates,
};
