// Tab 6, Retry storm (01 §5 step c5, §6; 02 §10; K4, K8, K9, K34). Server A: 4 replicas,
// extrapolated. Concepts 8 (fleet tail latency) and 9 (replica loss), extended by retry
// amplification and admission control.
//
// Lesson: timeouts and retries amplify an outage; backoff and admission control contain it. The
// lesson moment is a crash of replica 2 (index 1) at Wednesday's 10:30 peak, when the four replicas
// run close to capacity. Three replicas can't keep up, time to first token passes the clients' 10 s
// timeout, the server aborts the work, and clients retry at once. The named fix (full-jitter backoff
// plus a cap of 64 requests in flight per Ready replica) rejects the excess before it costs GPU
// time.
//
// Measured with the measured calibration (η_c 0.545, η_b 0.848, t_o 0.71 ms, KV pool 159k,
// 2,048-token batches), lessons.test.ts guards the numbers the copy quotes. In this model the storm lasts about
// as long as the outage (the replacement is Ready ~2 min after the crash): analysts abandon sessions
// once retries run out (K8), which sheds load, so goodput does not stay collapsed for 10 minutes as
// 00-build §7.3 proposed. The storm is milder than on the provisional calibration: offered load
// reaches ~2× first attempts over 2 minutes (2.9× in the worst minute, was 2.6× and 3.9×), and the
// fleet serves ~52% of its no-crash requests (was 35%).

import type { Patch, PatchTemplate, SimConfig } from '../../engine/api.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import { HOUR_MS, MINUTE_MS, SECOND_MS, simMs } from '../../engine/time.ts';
import type { StatusSnapshot } from '../../playback/types.ts';
import type { Scenario } from '../schema.ts';

/** The replica that crashes: index 1, shown as "replica 2". */
export const CRASHED_REPLICA = 1;
/** Wednesday 10:30, the peak of the busiest day (diurnal knot 10:30, day multiplier 1.1). */
export const LESSON_MOMENT_MS = simMs(2, 10, 30);
/** 5 minutes before the crash: Play shows the busy, healthy fleet first. Server A entries by ~12:00 (K30). */
export const ENTRY_MS = LESSON_MOMENT_MS - 5 * MINUTE_MS;
/** 50×: the crash comes 6 s after Play, and the storm and recovery play in about 4 s more. */
export const ENTRY_SPEED = 50;
/** The named fix's admission cap per Ready replica (K9). */
export const FIX_ADMISSION_LIMIT = 64;

const crash: PatchTemplate = { kind: 'event', event: { type: 'crash', replica: CRASHED_REPLICA } };

export const sim: SimConfig = {
  seed: 1,
  replicas: 4,
  // 3,200 analysts on Server A, each sending ~64 requests a day (16 conversations of ~4 turns).
  analystsPerReplica: 800,
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
    // Wednesday is the busiest day, and the lesson day; the other days peak lower and stay calm.
    dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
  },
  // Wednesday's 10:30 peak runs the fleet close to capacity (compute-bound prefill under
  // round-robin): ~9.5 requests/s, TTFT p99 about 4–6 s, and no timeouts without a crash. The
  // margin is narrow and noisy: across 15.6–17.4 conversations the crash's storm ranges from 1.5×
  // to 2.1× amplification over 2 minutes, and from ~17.2 the peak times out without any crash.
  // The measured calibration's faster replicas needed ~12% more load than the provisional 14.25.
  sessionsPerAnalystPerDay: 16,
  messageTokensSigma: 0.8,
  outputTokensSigma: 0.7,
  outputTokensMax: 4096,
  thinkTimeShape: 3,
  // E7: 64 virtual nodes let one replica own ~15.6% of the ring; 128 keeps affinity balanced.
  virtualNodesPerReplica: 128,
  routerOverheadMs: 2,
  // A few missed health checks before mark-down. Until then the router still sends the crashed
  // replica its share, and those requests fail at once.
  detectionDelayMs: 10_000,
  // A standby host loads the weights (25 s) and initializes the engine; Ready 115 s after detection.
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
    thinkTimeMedianMs: 90_000,
    // A short client timeout: healthy TTFT p99 is 4–6 s at the peak, so 10 s doesn't fire until a
    // replica is lost.
    timeoutToFirstTokenMs: 10_000,
    // The storm: each attempt that times out is retried at once, up to 3 times (4 attempts), then
    // the analyst abandons the session (K8).
    retryPolicy: 'immediate',
    // Used once the fix (or the drawer) picks a backoff policy. Full jitter then waits
    // uniform(0, 10 s), (0, 20 s), (0, 40 s): the three retries span about as long as a replica
    // replacement takes (~2 min). SDK defaults are shorter (0.5–1 s); they contain less.
    retryBaseMs: 10_000,
    retryCapMs: 60_000,
    maxRetries: 3,
    // Round-robin, deliberately (K34): under least-outstanding the crashed replica looks idle for
    // the 10 s before mark-down and draws nearly every request, which fail at once. Round-robin
    // sends it a quarter, so the storm comes from overload on the survivors, not the black hole.
    routingPolicy: 'roundRobin',
    hashScheme: 'consistent',
    signalRefreshMs: 1_000,
    // Off in the baseline; the named fix sets FIX_ADMISSION_LIMIT.
    admissionLimitPerReplica: null,
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
  },
};

const lessonPatch: Patch = { kind: 'event', atMs: LESSON_MOMENT_MS, event: crash.event };

function replicaName(r: number): string {
  return `Replica ${r + 1}`;
}

function oneDecimal(x: number): string {
  return x.toFixed(1);
}

function perS(x: number): string {
  return x >= 10 ? `${Math.round(x)}/s` : `${oneDecimal(x)}/s`;
}

/** The first replica in `state`, or null. */
function replicaIn(s: StatusSnapshot, ...states: number[]): number | null {
  const r = s.replicas.find((x) => states.includes(x.state));
  return r ? r.replica : null;
}

function readyCount(s: StatusSnapshot): number {
  return s.replicas.filter((x) => x.state === REPLICA_STATE.ready).length;
}

/** " TTFT p99 10.0 s." for the current minute, or "" before its bucket is computed. */
function ttftP99(s: StatusSnapshot): string {
  const ms = s.fleet.ttftP99Ms;
  return Number.isFinite(ms) ? ` TTFT p99 ${oneDecimal(ms / 1000)} s.` : '';
}

function abandonedToday(s: StatusSnapshot): string {
  const n = s.fleet.abandonedSessions;
  if (!(n >= 1)) return '';
  const k = Math.round(n);
  return ` ${k} ${k === 1 ? 'session' : 'sessions'} abandoned today.`;
}

export const scenario: Scenario = {
  id: 'retry-storm',
  tab: 6,
  title: 'Retry storm',
  preset: { name: 'Server A', replicas: 4, basis: 'extrapolated' },
  sim,
  baselinePatches: [lessonPatch],
  lessonMoment: { atMs: LESSON_MOMENT_MS, label: 'Replica 2 crashes at the morning peak' },
  entry: { atMs: ENTRY_MS, speed: ENTRY_SPEED },
  trigger: { label: 'Crash replica 2', patch: crash },
  namedFix: {
    label: 'Back off and cap admissions',
    changes: { retryPolicy: 'fullJitter', admissionLimitPerReplica: FIX_ADMISSION_LIMIT },
  },
  // An analyst mid-conversation when the replica crashes, with turns still to send. On seed 1 it is
  // analyst 2928: their turn at 10:31:44 times out, and so do two immediate retries; the third
  // retry, at 10:32:14, is served in 4.2 s.
  tracked: { rule: 'spansMoment', momentMs: LESSON_MOMENT_MS + 30 * SECOND_MS, minTurnsAfter: 2 },
  chart3: 'offeredVsAdmitted',
  lesson: {
    summary:
      'A replica crashes at the peak, and clients with a short timeout retry at once, turning a lost quarter of capacity into a retry storm.',
    takeaway:
      'Immediate retries multiply load exactly when capacity drops, and the GPUs burn time on requests whose clients have already given up. Backoff with jitter plus an admission limit keeps the surviving replicas serving useful work.',
  },
  // An hour around the crash: the busy peak, the storm, and the 10 minutes of lower goodput after.
  chartWindowMs: HOUR_MS,
  drawer: [
    {
      param: 'timeoutToFirstTokenMs',
      label: 'Client timeout',
      help: 'How long a client waits for the first token before it gives up. The server aborts the request too.',
      control: {
        kind: 'select',
        options: [
          { value: 5_000, label: '5 s' },
          { value: 10_000, label: '10 s' },
          { value: 30_000, label: '30 s' },
          { value: 60_000, label: '60 s' },
          { value: null, label: 'None' },
        ],
      },
    },
    {
      param: 'retryPolicy',
      label: 'Retry policy',
      help: 'What a client does after a timeout, a reject, or a failure. Backoff starts at 10 s.',
      control: {
        kind: 'select',
        options: [
          { value: 'none', label: 'No retries' },
          { value: 'immediate', label: 'Immediate' },
          { value: 'fixed', label: 'Fixed (10 s)' },
          { value: 'exponential', label: 'Exponential' },
          { value: 'fullJitter', label: 'Full jitter' },
        ],
      },
    },
    {
      param: 'maxRetries',
      label: 'Max retries',
      help: 'Retries per turn. When they run out, the analyst abandons the conversation.',
      control: { kind: 'range', min: 0, max: 6, step: 1 },
    },
    {
      param: 'admissionLimitPerReplica',
      label: 'Admission limit',
      help: 'Requests in flight allowed per Ready replica. The router rejects the rest at once.',
      control: {
        kind: 'select',
        options: [
          { value: null, label: 'Off' },
          { value: 32, label: '32 per replica' },
          { value: 48, label: '48 per replica' },
          { value: 64, label: '64 per replica' },
          { value: 96, label: '96 per replica' },
        ],
      },
    },
  ],
  copy: {
    whatToWatch: [
      'Server A’s four replicas run close to capacity at Wednesday’s 10:30 peak: about 9.5 requests a second, TTFT p99 around 4–6 s. Clients give up if no token arrives within 10 s, then retry at once, up to 3 times.',
      'At 10:30 replica 2 crashes; a standby host has it Ready again at 10:32. Meanwhile three replicas face the whole peak, and queues grow until TTFT passes 10 s. Clients time out, the server aborts their requests, and they are sent again. Offered load climbs from about 9 to over 20 requests a second, and all of it is admitted.',
      'Admitted is not served. In the 2 minutes after the crash, about 60% of the fleet’s prefill work goes to prompts whose clients have already left, and the fleet serves about half its normal requests. With the fix, the same three replicas serve three-quarters.',
      'When a turn’s retries run out, the analyst abandons the conversation: about 250 in 3 minutes. That sheds load, which is part of why the storm ends soon after the replica returns.',
    ],
    tryThis: [
      'Press Back off and cap admissions before 10:30, then play. The router admits at most 64 requests per Ready replica and rejects the rest at once; clients retry after a random wait of up to 10, 20, then 40 s. Admitted load stays at 7–9 a second, no more than before the crash; TTFT p99 stays under the 10 s timeout, and about 120 conversations are abandoned instead of 250.',
      'Set Retry policy to Full jitter, with no admission limit. Retries spread out and only about 70 conversations are abandoned, fewer than with the fix, but everything is still admitted: about 40% of the prefill work goes to timed-out prompts, and TTFT p99 stays at the 10 s timeout for 4 minutes.',
      'Set Client timeout to 60 s instead. No storm forms and almost nobody gives up, but TTFT p99 stays above 25 s for about 6 minutes while the backlog drains.',
    ],
  },
  // Levels (replica state) are at the playhead; rates and amplification are over the trailing
  // minute; TTFT p99 is the current minute; abandoned sessions count from the day's start.
  statusTemplates: [
    {
      id: 'crashed',
      priority: 50,
      render: (s) => {
        const r = replicaIn(s, REPLICA_STATE.crashed);
        if (r === null) return null;
        return `${replicaName(r)} has crashed. Until it is marked down, the router still sends it requests, and they fail at once.`;
      },
    },
    {
      id: 'storm',
      priority: 40,
      render: (s) => {
        const f = s.fleet;
        if (!(f.amplification >= 1.3) || f.rejectedPerS >= 0.1 * f.offeredPerS) return null;
        const served = Number.isFinite(f.finishedPerS)
          ? ` Offered ${perS(f.offeredPerS)}, served ${perS(f.finishedPerS)}.`
          : '';
        return `Retry storm: offered load is ${oneDecimal(f.amplification)}× first attempts, and all of it is admitted.${served}${ttftP99(s)}${abandonedToday(s)}`;
      },
    },
    {
      id: 'rejecting',
      priority: 35,
      render: (s) => {
        const f = s.fleet;
        if (!(f.rejectedPerS > 0.05)) return null;
        return `Admission control is rejecting ${perS(f.rejectedPerS)} and admitting ${perS(f.admittedPerS)}; clients back off and retry.${abandonedToday(s)}`;
      },
    },
    {
      id: 'recovering',
      priority: 30,
      render: (s) => {
        const loading = replicaIn(s, REPLICA_STATE.loadingWeights);
        const init = replicaIn(s, REPLICA_STATE.initializingEngine);
        const r = loading ?? init;
        if (r === null) return null;
        const phase = loading !== null ? 'loading weights' : 'initializing the engine';
        return `${replicaName(r)} is ${phase} on a standby host; ${readyCount(s)} replicas carry the load.${abandonedToday(s)}`;
      },
    },
    {
      id: 'down',
      priority: 30,
      render: (s) => {
        const r = replicaIn(s, REPLICA_STATE.down);
        if (r === null) return null;
        return `${replicaName(r)} is down; ${readyCount(s)} replicas carry the load.`;
      },
    },
    {
      id: 'serving',
      priority: 0,
      render: (s) => {
        const f = s.fleet;
        if (!Number.isFinite(f.offeredPerS)) return null;
        return `${readyCount(s)} replicas Ready, admitting ${perS(f.admittedPerS)}.${ttftP99(s)}${abandonedToday(s)}`;
      },
    },
  ],
};
