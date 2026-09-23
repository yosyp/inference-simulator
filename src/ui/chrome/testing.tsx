// Test support for the chrome, sidebar, and App tests: a real playback store over the fake engine,
// stepped by hand (no background timers), and a scenario that exercises every drawer control.
// Test-only; nothing in the app imports it.

import type { PlaybackStore, StatusSnapshot } from '../../playback/types.ts';
import { REPLICA_STATE } from '../../engine/results.ts';
import { fixtureScenarios } from '../../fixtures/scenarios.ts';
import { createFixturePlaybackStore } from '../../playback/fixture-store.ts';
import { createManualClock, createTaskQueue } from '../../playback/manual.ts';
import type { EngineClientStore } from '../../playback/store.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import { ControlPanel } from './ControlPanel.tsx';
import { ScenarioTabs } from './ScenarioTabs.tsx';
import { useScenarioRun } from './use-scenario-run.ts';

export interface TestStore {
  store: EngineClientStore;
  /** The fake engine's work; run it to deliver computed ranges and chunks. */
  queue: ReturnType<typeof createTaskQueue>;
  /** Wall clock and frame scheduler; `clock.frame()` advances playback. */
  clock: ReturnType<typeof createManualClock>;
}

export function createTestStore(): TestStore {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const store = createFixturePlaybackStore({
    fake: { schedule: queue.schedule },
    clock,
    frames: clock,
    onError: (message) => {
      throw new Error(message);
    },
  });
  return { store, queue, clock };
}

/**
 * The six placeholder tabs, with tab 4 given a named fix, a baseline 'set' patch at its lesson
 * moment, and a drawer with one control of each kind.
 */
export function testScenarios(): Scenario[] {
  return fixtureScenarios().map((s) => (s.tab === 4 ? routingTab(s) : s));
}

function routingTab(s: Scenario): Scenario {
  return {
    ...s,
    baselinePatches: [{ kind: 'set', atMs: s.lessonMoment.atMs, changes: { loadMultiplier: 1.5 } }],
    namedFix: { label: 'Use session affinity', changes: { routingPolicy: 'sessionAffinity' } },
    drawer: [
      ...s.drawer,
      {
        param: 'admissionLimitPerReplica',
        label: 'Admission control',
        help: 'Caps outstanding requests per Ready replica.',
        control: { kind: 'toggle', off: null, on: 8 },
      },
      {
        param: 'timeoutToFirstTokenMs',
        label: 'Client timeout',
        control: { kind: 'range', min: 10_000, max: 120_000, step: 5_000, unit: 'ms' },
      },
    ],
  };
}

/** A one- or two-replica status snapshot with the given replica fields. */
export function snapshot(
  replicas: Partial<StatusSnapshot['replicas'][number]>[],
  atMs = 0,
): StatusSnapshot {
  return {
    atMs,
    replicas: replicas.map((r, i) => ({
      replica: i,
      state: REPLICA_STATE.ready,
      phaseProgress: null,
      kvUsedFrac: 0.5,
      running: 4,
      waiting: 0,
      preemptionsPerMin: 0,
      prefillTokensPerS: 0,
      decodeTokensPerS: 0,
      nvidiaSmiUtil: 0.5,
      computeUtil: 0.2,
      ...r,
    })),
    fleet: {
      offeredPerS: 1,
      admittedPerS: 1,
      rejectedPerS: 0,
      amplification: 1,
      ttftP99Ms: 300,
      abandonedSessions: 0,
      finishedPerS: 1,
    },
  };
}

/** The tabs and the toolbar slot (toolbar plus drawer), wired the way App wires them. */
export function ChromeHarness({
  store,
  scenarios,
}: {
  store: PlaybackStore;
  scenarios: readonly Scenario[];
}) {
  const run = useScenarioRun(store, scenarios);
  return (
    <>
      <ScenarioTabs scenarios={run.scenarios} selectedId={run.scenario.id} onSelect={run.select} />
      <ControlPanel store={store} run={run} />
    </>
  );
}
