// The app: the shell (U1) with the tabs, toolbar, drawer, intro modal, and sidebar (U6).
// Canvas (U3), charts (U4), timeline (U5), and rollup table (U7) are placeholders until X1.

import { useState } from 'react';
import { calibration as appCalibration } from './data/calibration.ts';
import type { Calibration } from './engine/calibration.ts';
import { fixtureScenarios } from './fixtures/scenarios.ts';
import { createFixturePlaybackStore } from './playback/fixture-store.ts';
import type { PlaybackState, PlaybackStore } from './playback/types.ts';
import { usePlaybackSelector } from './playback/use-playback-selector.ts';
import type { Scenario } from './scenarios/schema.ts';
import {
  ControlPanel,
  IntroModal,
  ScenarioTabs,
  SlotPlaceholder,
  useScenarioRun,
} from './ui/chrome/index.ts';
import { AppShell } from './ui/shell/index.ts';
import { Sidebar } from './ui/sidebar/index.ts';

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
        canvas={
          <SlotPlaceholder
            title="Canvas"
            owner="U3"
            detail="Router, replicas, KV tanks, request dots"
            className="absolute inset-2"
          />
        }
        charts={
          <div className="flex flex-col px-2 py-1">
            {['Chart 1 · Latency', 'Chart 2 · Memory', `Chart 3 · ${run.scenario.chart3}`].map(
              (title) => (
                <div key={title} className="h-(--layout-chart-h) py-1">
                  <SlotPlaceholder title={title} owner="U4" className="h-full" />
                </div>
              ),
            )}
          </div>
        }
        timeline={
          <div className="flex h-(--layout-timeline-h) p-2">
            <SlotPlaceholder title="Week timeline" owner="U5" className="flex-1" />
          </div>
        }
        sidebar={
          <Sidebar
            store={store}
            scenario={run.scenario}
            mode={mode}
            calibration={calibration}
            rollup={<SlotPlaceholder title="Rollup table" owner="U7" className="h-32" />}
            onShowIntro={() => setIntroOpen(true)}
          />
        }
      />
      <IntroModal open={introOpen} onClose={() => setIntroOpen(false)} />
    </>
  );
}
