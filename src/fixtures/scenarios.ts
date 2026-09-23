// Placeholder scenarios for UI development (U5, U6) until C2 and C3 write the real ones.
// Values are illustrative, not tuned; copy is marked TODO(copy).

import type { SimConfig } from '../engine/api.ts';
import { HOUR_MS, simMs } from '../engine/time.ts';
import type { Preset, Scenario, TabId } from '../scenarios/schema.ts';
import { FIXTURE_SHIFT } from './synthetic.ts';

export function fixtureSimConfig(replicas: number): SimConfig {
  return {
    seed: 1,
    replicas,
    analystsPerReplica: 400,
    shift: FIXTURE_SHIFT,
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
    sessionsPerAnalystPerDay: 3,
    messageTokensSigma: 0.8,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeShape: 2,
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
      thinkTimeMedianMs: 90_000,
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
}

const PRESETS: Record<Preset['name'], Preset> = {
  '1 GPU': { name: '1 GPU', replicas: 1, basis: 'measured' },
  '2 replicas': { name: '2 replicas', replicas: 2, basis: 'measured' },
  'Server A': { name: 'Server A', replicas: 4, basis: 'extrapolated' },
  'Server B': { name: 'Server B', replicas: 8, basis: 'extrapolated' },
};

function placeholder(
  id: TabId,
  tab: Scenario['tab'],
  title: string,
  preset: Preset['name'],
  chart3: Scenario['chart3'],
): Scenario {
  const p = PRESETS[preset];
  const moment = simMs(2, 10, 30);
  return {
    id,
    tab,
    title,
    preset: p,
    sim: fixtureSimConfig(p.replicas),
    baselinePatches: [],
    lessonMoment: { atMs: moment, label: 'TODO(copy): lesson moment' },
    entry: { atMs: moment - 2 * 60_000, speed: 5 },
    trigger: { label: `TODO(copy): trigger for ${title}`, patch: { kind: 'set', changes: {} } },
    tracked: { rule: 'spansMoment', momentMs: moment, minTurnsAfter: 2 },
    chart3,
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
          ],
        },
      },
      {
        param: 'loadMultiplier',
        label: 'Load',
        control: { kind: 'range', min: 0.5, max: 2, step: 0.1, unit: '×' },
      },
    ],
    copy: {
      whatToWatch: [`TODO(copy): what to watch on ${title}.`],
      tryThis: ['TODO(copy): first suggestion.', 'TODO(copy): second suggestion.'],
    },
    statusTemplates: [
      {
        id: 'preempting',
        priority: 10,
        render: (s) => {
          const r = s.replicas.find((x) => x.preemptionsPerMin > 0);
          return r
            ? `Replica ${r.replica + 1} is preempting; KV at ${Math.round(r.kvUsedFrac * 100)}%`
            : null;
        },
      },
    ],
  };
}

export function fixtureScenarios(): Scenario[] {
  return [
    placeholder('long-prompt', 1, 'Long prompt', '1 GPU', 'utilization'),
    placeholder('knee', 2, 'Saturation knee', '1 GPU', 'utilization'),
    placeholder('kv-exhaustion', 3, 'KV exhaustion', '1 GPU', 'utilization'),
    placeholder('routing', 4, 'Routing', '2 replicas', 'perReplicaLoad'),
    placeholder('fail-recover', 5, 'Fail and recover', 'Server B', 'perReplicaLoad'),
    placeholder('retry-storm', 6, 'Retry storm', 'Server A', 'offeredVsAdmitted'),
  ];
}
