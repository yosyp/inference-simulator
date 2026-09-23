// The app: the shell (U1) with the tabs, toolbar, drawer, intro modal, and sidebar (U6), the canvas
// (U3), charts (U4), week timeline (U5), and High-side rollup table (U7).

import { useState } from 'react';
import { calibration as appCalibration } from './data/calibration.ts';
import type { Calibration } from './engine/calibration.ts';
import { ChartStack } from './charts/index.ts';
import { fixtureScenarios } from './fixtures/scenarios.ts';
import { createFixturePlaybackStore } from './playback/fixture-store.ts';
import type { PlaybackState, PlaybackStore } from './playback/types.ts';
import { usePlaybackSelector } from './playback/use-playback-selector.ts';
import type { Scenario } from './scenarios/schema.ts';
import { SimCanvas } from './sim-view/index.ts';
import { ControlPanel, IntroModal, ScenarioTabs, useScenarioRun } from './ui/chrome/index.ts';
import { AppShell } from './ui/shell/index.ts';
import { Sidebar } from './ui/sidebar/index.ts';
import { RollupTable } from './ui/high-side/index.ts';
import { WeekTimeline } from './ui/timeline/index.ts';

// --- Wiring. X1: swap these two for the scenario registry and the worker-backed store. -----------

function createAppScenarios(): readonly Scenario[] {
  return fixtureScenarios();
}

function createAppStore(): PlaybackStore {
  return createFixturePlaybackStore();
}

// -------------------------------------------------------------------------------------------------

// One store for the page's lifetime, created on first render. Module scope (not component state)
// keeps StrictMode's double render and double effects from creating or disposing a second one.
let sharedScenarios: readonly Scenario[] | null = null;
let sharedStore: PlaybackStore | null = null;
const defaultScenarios = () => (sharedScenarios ??= createAppScenarios());
const defaultStore = () => (sharedStore ??= createAppStore());

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sharedStore?.dispose();
    sharedStore = null;
  });
}

export interface AppProps {
  /** Default: the app's scenarios. Tests pass their own. */
  scenarios?: readonly Scenario[];
  /** Default: the app's store. A store passed in is not disposed by the app. */
  store?: PlaybackStore;
  calibration?: Calibration;
}

const selectMode = (s: PlaybackState) => s.mode;

export function App(props: AppProps) {
  const scenarios = props.scenarios ?? defaultScenarios();
  const store = props.store ?? defaultStore();
  const calibration = props.calibration ?? appCalibration;
  const run = useScenarioRun(store, scenarios);
  const mode = usePlaybackSelector(store, selectMode);
  const [introOpen, setIntroOpen] = useState(true);

  return (
    <>
      <AppShell
        mode={mode}
        tabs={
          <ScenarioTabs
            scenarios={run.scenarios}
            selectedId={run.scenario.id}
            onSelect={run.select}
          />
        }
        toolbar={<ControlPanel store={store} run={run} />}
        canvas={<SimCanvas store={store} />}
        charts={<ChartStack store={store} />}
        timeline={<WeekTimeline store={store} />}
        sidebar={
          <Sidebar
            store={store}
            scenario={run.scenario}
            mode={mode}
            calibration={calibration}
            rollup={<RollupTable store={store} />}
            onShowIntro={() => setIntroOpen(true)}
          />
        }
      />
      <IntroModal open={introOpen} onClose={() => setIntroOpen(false)} />
    </>
  );
}
