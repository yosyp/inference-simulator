// Tab 5 · Fail and recover (01 §5 step c4 and part of c5, concepts 7–11; 02 §10).
//
// Server B, 8 replicas, session affinity with mod-N hashing. At 09:15 on Wednesday, on the
// morning plateau, replica 3 crashes. The router keeps sending it requests until mark-down 10 s
// later; then mod-N remaps about 7/8 of sessions, so most follow-ups land on a replica without
// their history and re-prefill it. The replacement host loads weights, starts its engine, and
// rejoins with an empty cache about 2 minutes after the crash, and mod-N remaps most sessions a
// second time. Consistent hashing moves only replica 3's eighth. Under least-outstanding the
// crashed replica draws nearly all traffic until mark-down (K34), and the rejoined one takes a
// burst of cold requests.
//
// Measured on the provisional calibration (lessons.test.ts): in the three minutes after the crash
// the fleet's prefill work is 2.4× the 15 minutes before and TTFT mean 2.5× (p99 1.7×), against
// 1.3× for both under consistent hashing.

import type { SimConfig } from '../../engine/api.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import { HOUR_MS, MINUTE_MS, simMs } from '../../engine/time.ts';
import type { ReplicaSnapshot, StatusSnapshot } from '../../playback/types.ts';
import type { Scenario } from '../schema.ts';

/** Wednesday 09:15, on the morning plateau. */
export const CRASH_MS = simMs(2, 9, 15);
/**
 * The replica that crashes (R3). Not the tracked analyst's: mod-N moves their session anyway,
 * twice, while consistent hashing leaves it in place.
 */
export const CRASHED_REPLICA = 2;
const CRASHED_LABEL = `replica ${CRASHED_REPLICA + 1}`;

export const sim: SimConfig = {
  seed: 1,
  replicas: 8,
  analystsPerReplica: 400,
  shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
  diurnal: {
    // A quick ramp to a plateau from 08:45 to 10:30: the crash lands on a busy morning, and the
    // Server B entry point stays before 09:30 (K30).
    knots: [
      [7 * HOUR_MS, 0.3],
      [8 * HOUR_MS, 0.9],
      [8.75 * HOUR_MS, 1],
      [10.5 * HOUR_MS, 1],
      [12 * HOUR_MS, 0.6],
      [13 * HOUR_MS, 0.8],
      [15 * HOUR_MS, 0.8],
      [17 * HOUR_MS, 0.2],
    ],
    dayMultipliers: [0.95, 1, 1, 1, 0.85],
  },
  // 12 conversations of ~5 turns per analyst per day: ~7 requests/s across the fleet on the
  // plateau, ~7 outstanding per replica. The 140k-token KV pool then keeps most returning
  // histories (returning-turn hit rate ~0.8), which is what a crash throws away. Busier, LRU churn
  // evicts histories before analysts return (~0.6 at 16 per analyst, ~0.3 near the knee), and
  // affinity, and losing it, matters much less.
  sessionsPerAnalystPerDay: 12,
  messageTokensSigma: 0.8,
  outputTokensSigma: 0.7,
  outputTokensMax: 4096,
  thinkTimeShape: 3,
  // E7: 64 virtual nodes let one replica own ~16% of the ring; 128 keeps shares near 1/8.
  virtualNodesPerReplica: 128,
  routerOverheadMs: 2,
  // Health checks every 5 s, marked down after two misses.
  detectionDelayMs: 10_000,
  // Weights loaded ~25 s and engine ready ~115 s after process start (calibration, provisional).
  coldStart: 'replacementHost',
  engineOverrides: {},
  bucketMs: 10_000,
  histBucketMs: 60_000,
  tunable: {
    loadMultiplier: 1,
    systemPromptTokens: 800,
    turnsPerSessionMean: 5,
    messageTokensMedian: 150,
    outputTokensMedian: 300,
    // Quick follow-ups: 45 s median from one question to the next, heavy-tailed (β = 3). At this
    // load the pool holds about two minutes of traffic, so most histories outlast the gap.
    thinkTimeMedianMs: 45_000,
    timeoutToFirstTokenMs: 60_000,
    // Exponential backoff from 2 s: the third retry (+14 s) lands after mark-down (+10 s), so
    // requests caught by the crash finish on a survivor instead of abandoning their session.
    retryPolicy: 'exponential',
    retryBaseMs: 2_000,
    retryCapMs: 30_000,
    maxRetries: 3,
    routingPolicy: 'sessionAffinity',
    hashScheme: 'modN',
    signalRefreshMs: 1_000,
    admissionLimitPerReplica: null,
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
  },
};

function name(r: ReplicaSnapshot): string {
  return `Replica ${r.replica + 1}`;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function inState(s: StatusSnapshot, state: number): ReplicaSnapshot | undefined {
  return s.replicas.find((r) => r.state === state);
}

function others(s: StatusSnapshot): number {
  return s.replicas.filter((r) => r.state === REPLICA_STATE.ready).length;
}

export const scenario: Scenario = {
  id: 'fail-recover',
  tab: 5,
  title: 'Fail and recover',
  preset: { name: 'Server B', replicas: 8, basis: 'extrapolated' },
  sim,
  baselinePatches: [
    { kind: 'event', atMs: CRASH_MS, event: { type: 'crash', replica: CRASHED_REPLICA } },
  ],
  lessonMoment: { atMs: CRASH_MS, label: `Replica ${CRASHED_REPLICA + 1} crashes` },
  // 5 simulated minutes before the crash at 50×: 6 s of wall time; the replacement rejoins about
  // 2.5 s after the crash.
  entry: { atMs: CRASH_MS - 5 * MINUTE_MS, speed: 50 },
  trigger: {
    label: `Crash replica ${CRASHED_REPLICA + 1}`,
    patch: { kind: 'event', event: { type: 'crash', replica: CRASHED_REPLICA } },
  },
  tracked: { rule: 'spansMoment', momentMs: CRASH_MS, minTurnsAfter: 3 },
  chart3: 'perReplicaLoad',
  lesson: {
    summary:
      'One of eight replicas crashes and is replaced, while session affinity uses mod-N hashing.',
    takeaway:
      'Losing a replica costs more than its share of capacity: mod-N hashing moves most conversations away from their cached history, twice, once at the crash and again at the rejoin. Consistent hashing moves only the lost replica’s eighth.',
  },
  // An hour around the crash: the steady morning, the outage and rejoin, and the settling.
  chartWindowMs: HOUR_MS,
  drawer: [
    {
      param: 'hashScheme',
      label: 'Hash scheme',
      help: 'How session affinity maps a session to a replica. Changing it remaps sessions too.',
      control: {
        kind: 'select',
        options: [
          { value: 'modN', label: 'Mod-N' },
          { value: 'consistent', label: 'Consistent' },
        ],
      },
    },
    {
      param: 'routingPolicy',
      label: 'Routing policy',
      help: 'Applies to requests sent after the change.',
      control: {
        kind: 'select',
        options: [
          { value: 'sessionAffinity', label: 'Session affinity' },
          { value: 'leastOutstanding', label: 'Least outstanding' },
          { value: 'roundRobin', label: 'Round-robin' },
        ],
      },
    },
    {
      param: 'loadMultiplier',
      label: 'Load',
      help: 'Scales how often conversations start. Applies to conversations that start later.',
      control: { kind: 'range', min: 0.5, max: 1.5, step: 0.1, unit: '×' },
    },
  ],
  copy: {
    whatToWatch: [
      'Eight replicas serve 3,200 analysts. Session affinity hashes each conversation’s ID, mod 8, to pick its replica, so about 80% of a follow-up’s prompt tokens are already in that replica’s KV cache.',
      `At 09:15 ${CRASHED_LABEL} crashes. For 10 s, until it is marked down, the router keeps sending it requests, which fail; clients retry with backoff. Then mod-N hashes over 7 replicas, and about 7 in 8 conversations move. Each moved follow-up prefills its whole history again: for about a minute the fleet does more than twice its usual prefill work, and TTFT mean nearly triples.`,
      'The replacement loads weights and starts its engine, and rejoins at 09:17 with an empty cache. Mod-N moves most conversations again, and TTFT rises a second time; by 09:20 it has mostly settled. The tracked analyst’s replica never crashed, yet their conversation moved twice.',
      'On the latency chart, the black line is the worst replica’s TTFT p99; the fleet’s p99 sits above most replicas’ own, because the slowest replicas set the tail. Losing 1 of 8 replicas costs far more than 1/8 of capacity.',
    ],
    tryThis: [
      `In Parameters, set Hash scheme to Consistent. The switch itself remaps conversations, so play a few minutes, then press Crash ${CRASHED_LABEL}. Only its conversations move, about 1 in 8, and TTFT rises much less.`,
      `Set Routing policy to Least outstanding and press Crash ${CRASHED_LABEL}. Until mark-down it fails requests instantly, so its count stays at zero and it draws nearly every request. When it rejoins, it takes every new request for a second or two, and none finds its history there.`,
      `Switch to High side and play to Thursday 12:00. Wednesday’s rollup shows ${CRASHED_LABEL} serving about as many requests as the others: the outage doesn’t show in a daily count.`,
    ],
  },
  // Replica states are exact at the playhead; KV is the current 10 s bucket; the fleet p99 is the
  // current minute's.
  statusTemplates: [
    {
      id: 'crashed',
      priority: 40,
      render: (s) => {
        const r = inState(s, REPLICA_STATE.crashed);
        return r
          ? `${name(r)} has crashed. Until it is marked down, the router still sends it requests, and they fail.`
          : null;
      },
    },
    {
      id: 'down',
      priority: 35,
      render: (s) => {
        const r = inState(s, REPLICA_STATE.down);
        return r ? `${name(r)} is marked down; a replacement host is starting.` : null;
      },
    },
    {
      id: 'loadingWeights',
      priority: 30,
      render: (s) => {
        const r = inState(s, REPLICA_STATE.loadingWeights);
        if (!r) return null;
        const done = r.phaseProgress === null ? '' : ` (${pct(r.phaseProgress)})`;
        return `${name(r)}’s replacement is loading weights${done}. ${others(s)} replicas carry the traffic.`;
      },
    },
    {
      id: 'initializingEngine',
      priority: 30,
      render: (s) => {
        const r = inState(s, REPLICA_STATE.initializingEngine);
        if (!r) return null;
        const done = r.phaseProgress === null ? '' : ` (${pct(r.phaseProgress)})`;
        return `${name(r)}’s replacement is starting its engine${done}. It will rejoin with an empty KV cache.`;
      },
    },
    {
      id: 'preempting',
      priority: 20,
      render: (s) => {
        const r = s.replicas.find((x) => x.preemptionsPerMin > 0);
        return r ? `${name(r)} is preempting; KV at ${pct(r.kvUsedFrac)}.` : null;
      },
    },
    {
      id: 'ready',
      priority: 0,
      render: (s) => {
        const ready = others(s);
        if (ready !== s.replicas.length || !Number.isFinite(s.fleet.ttftP99Ms)) return null;
        return `All ${ready} replicas ready. Fleet TTFT p99 this minute: ${seconds(s.fleet.ttftP99Ms)}.`;
      },
    },
  ],
};
