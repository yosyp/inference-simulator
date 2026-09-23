// The selected tab and its run (05 §3, K16). Selecting a tab loads its scenario, which starts a
// fresh run; Reset does the same in place. Every fork goes through `fork`, which also remembers
// lasting ('set') changes so the drawer can show the parameters in effect at the playhead.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { patchAt, type Patch, type PatchTemplate, type TunableParams } from '../../engine/api.ts';
import type { PlaybackState, PlaybackStore } from '../../playback/types.ts';
import { usePlaybackSelector } from '../../playback/use-playback-selector.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import { paramsAt, sameParams } from './params.ts';

/** The 'set' patches one run's forks applied, in the order they were made. */
export interface AppliedPatches {
  runId: number;
  patches: readonly Patch[];
}

export interface ScenarioRun {
  /** The scenarios in teaching order (by tab number). */
  scenarios: readonly Scenario[];
  scenario: Scenario;
  /** Selects a tab; its scenario loads with a fresh run (forks discarded). */
  select(id: string): void;
  /** Forks at the playhead with this template; the label marks the fork on the charts and timeline. */
  fork(template: PatchTemplate, label: string): void;
  applied: AppliedPatches;
}

const NONE: AppliedPatches = { runId: -1, patches: [] };

export function useScenarioRun(store: PlaybackStore, scenarios: readonly Scenario[]): ScenarioRun {
  const ordered = useMemo(() => [...scenarios].sort((a, b) => a.tab - b.tab), [scenarios]);
  if (ordered.length === 0) throw new Error('useScenarioRun needs at least one scenario');
  const [selectedId, setSelectedId] = useState<string>(ordered[0]!.id);
  const scenario = ordered.find((s) => s.id === selectedId) ?? ordered[0]!;
  const [applied, setApplied] = useState<AppliedPatches>(NONE);

  // Load on mount and on every tab change. A store already on this scenario is left alone, so a
  // StrictMode re-run doesn't restart the run.
  useEffect(() => {
    if (store.getState().scenarioId !== scenario.id) store.loadScenario(scenario);
  }, [store, scenario]);

  const fork = useCallback(
    (template: PatchTemplate, label: string) => {
      const before = store.getState();
      const patch = patchAt(template, before.playheadMs);
      store.fork(patch, label);
      // The store ignores forks before a scenario loads or after dispose.
      if (store.getState().revision === before.revision || patch.kind !== 'set') return;
      const runId = before.runId;
      setApplied((prev) => ({
        runId,
        patches: prev.runId === runId ? [...prev.patches, patch] : [patch],
      }));
    },
    [store],
  );

  return { scenarios: ordered, scenario, select: setSelectedId, fork, applied };
}

/**
 * The tunable parameters in effect at the playhead: the scenario's values, its baseline 'set'
 * patches, and this run's applied forks. Re-renders only when a value changes.
 */
export function useParamsInEffect(
  store: PlaybackStore,
  scenario: Scenario,
  applied: AppliedPatches,
): TunableParams {
  const selector = useCallback(
    (s: PlaybackState) => {
      const forks = s.runId === applied.runId ? applied.patches : [];
      return paramsAt(scenario.sim.tunable, [...scenario.baselinePatches, ...forks], s.playheadMs);
    },
    [scenario, applied],
  );
  return usePlaybackSelector(store, selector, { equals: sameParams });
}
