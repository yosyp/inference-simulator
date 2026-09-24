// Tab 2 · Saturation knee (01 §3, §6; 02 §10). One GPU, many analysts (stage b). The lesson: near
// capacity, TTFT p99 pulls away from the mean, and the mean hides it.
//
// Capacity. On one replica with multi-turn history and prefix caching, this workload serves about
// 2.5 requests/s on the measured calibration (X4). That is far below R3's ~16–17 requests/s knee
// for short requests: here some 150 conversations are open at once, their histories (1–17k tokens)
// far outgrow the 158,864-token KV pool, so most returning turns miss the prefix cache and
// re-prefill their history in 2,048-token chunks. Near that rate, bursts of arrivals fill the KV
// pool, new requests wait for blocks, and the few caught in a burst set p99. Most never wait.
//
// The week. Wednesday has the highest day multiplier; its 09:30–11:30 plateau alone runs at about
// 1.4 requests/s (55% of capacity). The lesson moment is a one-shot loadSpike at Wednesday 10:00
// that raises session starts 80% for an hour, taking arrivals to about 2.5 requests/s. Over that
// hour TTFT p99 is ~10.5 s against ~1.2 s the hour before; the mean goes from ~0.2 s to ~0.8 s.
// The other days peak at 1.0–1.3 requests/s and stay calm (hourly p99 under 1.7 s).
//
// Why a loadSpike and not a 'set' of loadMultiplier. The spike is one-shot: it ends on its own, so
// the recovery is on screen, the trigger recomputes only the playhead's day, and the High-side
// rollups for the other days stay the baseline's. A lasting 'set' would raise Thursday and Friday
// too. The drawer's Load control is the lasting version for visitors who want it.
//
// The knee is sharp and the seed matters. X4 retune on the measured calibration (η_c 0.545, η_b
// 0.848, t_o 0.71 ms, 2,048-token chunks, 18.9 ms per request, 6.2 µs per cached token): the old
// 1.5× spike no longer reached the knee (p99 1.6 s), and seeds 2–3 collapse at 1.75× (mean TTFT
// 5–12 s). Seed 1 passes the lesson for spikes of 1.75×–1.85× (p99 ~8 s to ~14 s); 1.7× is too calm
// (p99 only 4× the 50%-load value) and 1.9× collapses (mean ~9 s). 1.8× sits mid-band. Think time
// went from 90 s to 60 s: fewer open conversations keep more prefixes cached, which trims the
// cache-miss tail at half load (p99 1.1 s instead of 1.6–1.8 s) so the knee stands out from it.
// Retune the spike, not the seed, when the calibration changes.

import type { SimConfig } from '../../engine/api.ts';
import { HOUR_MS, MINUTE_MS, simMs } from '../../engine/time.ts';
import type { StatusSnapshot } from '../../playback/types.ts';
import type { Scenario } from '../schema.ts';

/** Wednesday 10:00, half an hour into the diurnal plateau. */
export const LESSON_MOMENT_MS = simMs(2, 10);
/** Session-start multiplier of the lesson moment's spike. */
export const LESSON_SPIKE = 1.8;
export const LESSON_SPIKE_MS = 60 * MINUTE_MS;

const spike = {
  type: 'loadSpike',
  multiplier: LESSON_SPIKE,
  durationMs: LESSON_SPIKE_MS,
} as const;

export const kneeSimConfig: SimConfig = {
  seed: 1,
  replicas: 1,
  // One A100 shared by a whole office. 800 analysts × 10 conversations a day × ~4 turns is about
  // 31,000 requests on an ordinary day and puts Wednesday's plateau at ~55% of capacity.
  analystsPerReplica: 800,
  shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
  diurnal: {
    // Morning ramp to a 09:30–11:30 plateau, lunch dip, smaller afternoon hump. The plateau keeps
    // the spike hour near capacity throughout; the ramp holds the 50%-load point (about 09:10), so
    // chart 1 shows mean and p99 rising together before they separate.
    knots: [
      [6.5 * HOUR_MS, 0],
      [7 * HOUR_MS, 0.3],
      [9.5 * HOUR_MS, 1],
      [11.5 * HOUR_MS, 1],
      [12.5 * HOUR_MS, 0.6],
      [14.5 * HOUR_MS, 0.85],
      [17 * HOUR_MS, 0],
    ],
    // Wednesday is the busiest day, so the week's knee lands on the lesson day.
    dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
  },
  // A heavy but ordinary user: ten conversations over a ten-hour shift.
  sessionsPerAnalystPerDay: 10,
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
    messageTokensMedian: 150,
    outputTokensMedian: 300,
    // A minute to read a ~300-token answer and type the next question (see the header: X4).
    thinkTimeMedianMs: 60_000,
    // A chat client's give-up time. In the spike hour p99 stays well under it (no timeouts), so
    // the tail is queueing, not retries.
    timeoutToFirstTokenMs: 60_000,
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

const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000));
const percent = (frac: number) => `${Math.round(frac * 100)}%`;

function gpu(s: StatusSnapshot) {
  return s.replicas[0] ?? null;
}

export const scenario: Scenario = {
  id: 'knee',
  tab: 2,
  title: 'Saturation knee',
  preset: { name: '1 GPU', replicas: 1, basis: 'measured' },
  sim: kneeSimConfig,
  baselinePatches: [{ kind: 'event', atMs: LESSON_MOMENT_MS, event: spike }],
  lessonMoment: { atMs: LESSON_MOMENT_MS, label: 'Arrivals rise 80% for an hour' },
  entry: { atMs: simMs(2, 9, 55), speed: 50 },
  trigger: { label: 'Raise arrivals 80% for an hour', patch: { kind: 'event', event: spike } },
  tracked: { rule: 'spansMoment', momentMs: LESSON_MOMENT_MS, minTurnsAfter: 2 },
  chart3: 'utilization',
  lesson: {
    summary: 'One GPU shared by 800 analysts is pushed close to what it can serve for an hour.',
    takeaway:
      'Near capacity, the slowest requests wait many times longer while the average barely moves: p99 time to first token reached 10.5 s against a 0.8 s mean. Watch p99, not the mean, and keep peak load below the knee.',
  },
  // Three hours around 10:00: the calm hour before, the spike hour, and the recovery.
  chartWindowMs: 3 * HOUR_MS,
  drawer: [
    {
      param: 'loadMultiplier',
      label: 'Load',
      help: 'Scales how often analysts start conversations, from now on and on later days.',
      control: { kind: 'range', min: 0.5, max: 1.5, step: 0.05, unit: '×' },
    },
    {
      param: 'outputTokensMedian',
      label: 'Median answer length',
      help: 'Longer answers keep each request on the GPU, and in the KV cache, for longer.',
      control: { kind: 'range', min: 100, max: 800, step: 50, unit: 'tokens' },
    },
    {
      param: 'thinkTimeMedianMs',
      label: 'Median think time',
      help: 'Time between an answer and the analyst’s next message.',
      control: { kind: 'range', min: 30_000, max: 300_000, step: 15_000, unit: 'ms' },
    },
  ],
  copy: {
    whatToWatch: [
      'One GPU serves 800 analysts. Wednesday is the busiest day of the week. At 10:00, arrivals rise 80% for an hour, to about 2.5 requests per second: close to what this GPU can serve.',
      'Chart 1 plots TTFT mean and p99 on a log scale. In the hour before 10:00, the mean is about 0.2 s and p99 about 1.2 s. From 10:07, p99 jumps to several seconds in short bursts, up to 16.5 s around 10:17. Over the hour, p99 is 10.5 s and the mean is 0.8 s.',
      'Near capacity, a burst of arrivals fills the KV cache (chart 2), and new requests wait until blocks free up. The requests caught in a burst set p99. Most requests never wait, so the mean moves much less.',
      'Chart 3 gives no warning. nvidia-smi-style utilization reads 100% at the peak on every day, busy or calm.',
    ],
    tryThis: [
      'Go to Wednesday 08:00, when arrivals are much lower, and press Raise arrivals. The same 80% rise moves the hour’s p99 only from about 0.8 s to 1.4 s.',
      'Before 10:00, set Load to 0.8×. The rise then brings arrivals to about 2 requests per second, and p99 stays near 1.4 s.',
      'Go to Thursday 12:00, when Wednesday’s rollup arrives, and switch to High side. Wednesday’s mean end-to-end latency is about 10 s, against 6–7 s on the other days. The bursts are gone.',
    ],
  },
  statusTemplates: [
    {
      id: 'preempting',
      priority: 30,
      render: (s) => {
        const r = gpu(s);
        if (!r || !(r.preemptionsPerMin > 0)) return null;
        return `KV cache full (${percent(r.kvUsedFrac)}): preempting requests; ${Math.round(r.waiting)} waiting`;
      },
    },
    {
      id: 'queue',
      priority: 20,
      render: (s) => {
        const r = gpu(s);
        if (!r || !(Math.round(r.waiting) >= 1)) return null;
        const p99 = Number.isFinite(s.fleet.ttftP99Ms)
          ? `; TTFT p99 this minute ${seconds(s.fleet.ttftP99Ms)} s`
          : '';
        return `${Math.round(r.waiting)} waiting for KV space${p99}`;
      },
    },
    {
      id: 'running',
      priority: 10,
      render: (s) => {
        const r = gpu(s);
        if (!r || !(r.running >= 0.5)) return null;
        return `Running ${Math.round(r.running)} requests; KV cache ${percent(r.kvUsedFrac)}; no queue`;
      },
    },
  ],
};
