// Tab 4 · Routing (01 §3 point 4, §5 stage c steps c1–c3; 02 §10). Two measured replicas.
//
// Lesson: least-busy routing can be the wrong answer. Each replica caches only the conversations
// it served, so a follow-up sent to the other replica prefills its history again. Session affinity
// keeps returning turns warm at the cost of less even load.
//
// Shape of the week: session affinity until Wednesday 10:30, when the router switches to
// round-robin (the lesson moment, K1). Round-robin stays in effect for the rest of the week, so
// the busy stretch after the moment is the one 01 §6 describes. The trigger re-applies that switch
// at the playhead: 02 §10 has the trigger make follow-ups move and TTFT rise, which needs affinity
// before it. The named fix switches back. The two buttons are opposites, so a visitor can flip
// between them at any time.
//
// The narrow window (02 §14 item 5): under affinity a history must survive its analyst's think
// time in the 140k-token pool. That holds while each replica turns over its free cache more slowly
// than analysts return. Measured on the provisional calibration at the lesson moment: returning-turn
// hit rate 0.87 at a 60 s think-time median, 0.70 at 90 s, and 0.16 at 3 min, where affinity no
// longer helps. So the load, turn sizes, and think time below sit together; change one and recheck
// lessons.test.ts.

import type { SimConfig } from '../../engine/api.ts';
import { HOUR_MS, MINUTE_MS, SECOND_MS, simMs } from '../../engine/time.ts';
import type { StatusSnapshot } from '../../playback/types.ts';
import type { Scenario, StatusTemplate } from '../schema.ts';

/** Wednesday 10:30, the diurnal peak: the router switches to round-robin. */
export const LESSON_MS = simMs(2, 10, 30);

export const routingSim: SimConfig = {
  // Seed 4's tracked analyst has four turns on one replica before the switch, then moves twice in
  // the first four minutes after it (checked in lessons.test.ts).
  seed: 4,
  replicas: 2,
  // 200 analysts per replica at 10 sessions each: about 0.3 requests/s and 7 running per replica at
  // the peak. Busy enough to fill the canvas; light enough that histories survive (see above).
  analystsPerReplica: 200,
  shift: { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS },
  diurnal: {
    // A morning peak at 10:30, a lunch dip, and a smaller afternoon peak.
    knots: [
      [7 * HOUR_MS, 0.2],
      [9 * HOUR_MS, 0.8],
      [10.5 * HOUR_MS, 1],
      [12 * HOUR_MS, 0.6],
      [13 * HOUR_MS, 0.7],
      [15 * HOUR_MS, 0.8],
      [17 * HOUR_MS, 0.1],
    ],
    dayMultipliers: [0.95, 1, 1.05, 1, 0.85],
  },
  // Short chat sessions through the day (reading, drafting, checking); with ~4 turns each, about
  // 40 requests per analyst per day.
  sessionsPerAnalystPerDay: 10,
  // Some messages carry pasted excerpts, so the message tail is wide.
  messageTokensSigma: 0.9,
  outputTokensSigma: 0.6,
  outputTokensMax: 2048,
  // Log-logistic think time (K23): β = 3 keeps a finite variance and a real tail of long pauses.
  thinkTimeShape: 3,
  // Only used under consistent hashing (E7 advises ≥ 128).
  virtualNodesPerReplica: 128,
  routerOverheadMs: 2,
  detectionDelayMs: 10_000,
  coldStart: 'replacementHost',
  engineOverrides: {},
  bucketMs: 10_000,
  histBucketMs: 60_000,
  tunable: {
    loadMultiplier: 1,
    // A shared system prompt, computed once per replica (concept 4). Kept short so the history,
    // not the shared prefix, is most of a returning turn's prompt.
    systemPromptTokens: 400,
    // Geometric mean 4 (c2). Longer conversations push the history past what the pool can hold.
    turnsPerSessionMean: 4,
    // Each turn adds ~1,000 tokens of history (message + answer), so a moved third turn
    // recomputes ~2,000–3,000 tokens: several hundred ms instead of tens.
    messageTokensMedian: 300,
    outputTokensMedian: 500,
    // Reading a ~500-token answer and sending the next question. At 90 s affinity loses about
    // a third of its hits; at 3 min, nearly all.
    thinkTimeMedianMs: 60_000,
    timeoutToFirstTokenMs: 60_000,
    retryPolicy: 'exponential',
    retryBaseMs: 1_000,
    retryCapMs: 30_000,
    maxRetries: 3,
    // Affinity until the lesson moment; the baseline patch switches to round-robin.
    routingPolicy: 'sessionAffinity',
    // With two replicas, mod-N splits sessions evenly; tab 5 teaches the hash schemes.
    hashScheme: 'modN',
    signalRefreshMs: 1_000,
    admissionLimitPerReplica: null,
    // Equal weights: at 2 replicas this keeps ~98% of returning turns home while shedding some
    // load from the busier replica.
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
  },
};

function replicaName(r: number): string {
  return `Replica ${r + 1}`;
}

function inFlight(r: StatusSnapshot['replicas'][number]): number {
  return Math.round(r.running + r.waiting);
}

function formatMs(ms: number): string {
  return ms < SECOND_MS ? `${Math.round(ms)} ms` : `${(ms / SECOND_MS).toFixed(1)} s`;
}

const statusTemplates: StatusTemplate[] = [
  {
    id: 'preempting',
    priority: 30,
    render: (s) => {
      const r = s.replicas.find((x) => x.preemptionsPerMin > 0);
      return r
        ? `${replicaName(r.replica)} is preempting; KV at ${Math.round(r.kvUsedFrac * 100)}%.`
        : null;
    },
  },
  {
    // Uneven load: one replica has at least twice the other's requests, and 4 more.
    id: 'uneven',
    priority: 20,
    render: (s) => {
      if (s.replicas.length !== 2) return null;
      const [a, b] = s.replicas.map(inFlight) as [number, number];
      const hi = a >= b ? 0 : 1;
      const [max, min] = hi === 0 ? [a, b] : [b, a];
      if (!(max >= 2 * min && max - min >= 4)) return null;
      return `${replicaName(hi)} has ${max} requests in flight; replica ${2 - hi} has ${min}.`;
    },
  },
  {
    // Heavy prefill: under round-robin, mostly history computed again on the other replica.
    id: 'prefill',
    priority: 10,
    render: (s) => {
      let top: StatusSnapshot['replicas'][number] | null = null;
      for (const r of s.replicas) {
        if (r.prefillTokensPerS >= 800 && (!top || r.prefillTokensPerS > top.prefillTokensPerS)) {
          top = r;
        }
      }
      if (!top) return null;
      const rate = Math.round(top.prefillTokensPerS / 10) * 10;
      return `${replicaName(top.replica)} is prefilling ${rate.toLocaleString('en-US')} tokens/s.`;
    },
  },
  {
    id: 'ttft',
    priority: 0,
    render: (s) =>
      Number.isFinite(s.fleet.ttftP99Ms)
        ? `Fleet TTFT p99 this minute: ${formatMs(s.fleet.ttftP99Ms)}.`
        : null,
  },
];

export const scenario: Scenario = {
  id: 'routing',
  tab: 4,
  title: 'Routing',
  preset: { name: '2 replicas', replicas: 2, basis: 'measured' },
  sim: routingSim,
  baselinePatches: [{ kind: 'set', atMs: LESSON_MS, changes: { routingPolicy: 'roundRobin' } }],
  lessonMoment: { atMs: LESSON_MS, label: 'The router switches to round-robin' },
  // 2 simulated minutes before the switch at 10×: 12 s of wall time, with two of the tracked
  // analyst's turns staying on one replica first. 10× is the fastest speed that still draws dots.
  entry: { atMs: LESSON_MS - 2 * MINUTE_MS, speed: 10 },
  trigger: {
    label: 'Switch to round-robin',
    patch: { kind: 'set', changes: { routingPolicy: 'roundRobin' } },
  },
  namedFix: {
    label: 'Switch to session affinity',
    changes: { routingPolicy: 'sessionAffinity' },
  },
  // A conversation that spans the switch with at least four turns after it.
  tracked: { rule: 'spansMoment', momentMs: LESSON_MS, minTurnsAfter: 4 },
  chart3: 'perReplicaLoad',
  drawer: [
    {
      param: 'routingPolicy',
      label: 'Routing policy',
      control: {
        kind: 'select',
        options: [
          { value: 'roundRobin', label: 'Round-robin' },
          { value: 'leastOutstanding', label: 'Least outstanding' },
          { value: 'sessionAffinity', label: 'Session affinity' },
          { value: 'kvUtilization', label: 'KV utilization' },
          { value: 'weighted', label: 'Weighted scoring' },
        ],
      },
    },
    {
      param: 'turnsPerSessionMean',
      label: 'Turns per conversation',
      help: 'Mean, for conversations that start after the change. At 1, no turn has history to reuse.',
      control: { kind: 'range', min: 1, max: 8, step: 1 },
    },
    {
      param: 'thinkTimeMedianMs',
      label: 'Think time',
      help: 'Median pause between turns, for conversations that start after the change. A history evicted during the pause is computed again, even under affinity.',
      control: { kind: 'range', min: 15_000, max: 5 * MINUTE_MS, step: 15_000, unit: 'ms' },
    },
    {
      param: 'signalRefreshMs',
      label: 'Load signal refresh',
      help: 'How often the router samples each replica’s load. Least outstanding, KV utilization, and weighted scoring act on the last sample.',
      control: { kind: 'range', min: 250, max: 30_000, step: 250, unit: 'ms' },
    },
  ],
  copy: {
    whatToWatch: [
      'Each replica holds its own copy of the model and its own KV cache. A follow-up turn is fast only on the replica that still holds its conversation. On the other replica, the whole conversation is prefilled again.',
      'Until Wednesday 10:30 the router uses session affinity, so each conversation stays on one replica. At 10:30 it switches to round-robin, which sends each request to the next replica in turn.',
      'Watch the tracked analyst. After the switch, about half of their turns land on the other replica and are marked as moved. Those turns take several hundred milliseconds to first token instead of tens. A turn that goes back to a replica it used earlier finds part of its history there and recomputes only the rest.',
      'Round-robin evens out the two replicas on the load chart. Least outstanding evens them out further, and its returning turns are just as slow. Affinity leaves one replica busier than the other; that is the price of keeping histories warm.',
    ],
    tryThis: [
      'Press Switch to session affinity and follow the tracked analyst: their next turns stay on one replica. Then compare the two replicas on the load chart.',
      'In Parameters, set Turns per conversation to 1. Conversations that start after the change are single requests with no history, and round-robin and affinity give about the same TTFT.',
      'Under session affinity, set Think time to 3 minutes. Histories start to be evicted before analysts return, and follow-ups slow down even though they stay on their replica.',
    ],
  },
  statusTemplates,
};
