// The app: the shell (U1) with the tabs, toolbar, drawer, intro modal, and sidebar (U6), the canvas
// (U3), charts (U4), week timeline (U5), and High-side rollup table (U7).

import { useRef, useState } from 'react';
import { calibration as appCalibration } from './data/calibration.ts';
import type { Calibration } from './engine/calibration.ts';
import { ChartStack } from './charts/index.ts';
import { createResultsStore } from './playback/index/index.ts';
import { createPlaybackStore } from './playback/store.ts';
import { createWorkerTransport } from './playback/worker-transport.ts';
import type { PlaybackState, PlaybackStore } from './playback/types.ts';
import { usePlaybackSelector } from './playback/use-playback-selector.ts';
import { scenarios as registryScenarios } from './scenarios/index.ts';
import type { Scenario } from './scenarios/schema.ts';
import { SimCanvas } from './sim-view/index.ts';
import {
  ControlPanel,
  HeaderActions,
  IntroModal,
  ScenarioTabs,
  ShortcutsModal,
  speedChoices,
  useScenarioRun,
  useShortcuts,
  type ScenarioRun,
  type ShortcutHit,
} from './ui/chrome/index.ts';
import { playableAt } from './playback/shift.ts';
import { initTheme, toggleTheme, useTheme } from './ui/theme/theme-state.ts';
import { AppShell } from './ui/shell/index.ts';
import { Sidebar } from './ui/sidebar/index.ts';
import { RollupTable } from './ui/high-side/index.ts';
import { WeekTimeline } from './ui/timeline/index.ts';

// --- Wiring: the scenario registry, and a store that runs the real engine in a Web Worker (E11). --

function createAppScenarios(): readonly Scenario[] {
  return registryScenarios();
}

function createAppStore(): PlaybackStore {
  return createPlaybackStore({
    transport: createWorkerTransport(),
    createResults: createResultsStore,
  });
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

// Follow prefers-color-scheme from the first render; the toggle and `d` override it in memory.
initTheme();

interface ShortcutContext {
  store: PlaybackStore;
  run: ScenarioRun;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleHelp: () => void;
}

/** Performs one keyboard shortcut (ui/chrome/shortcuts.ts). */
function runShortcut(hit: ShortcutHit, ctx: ShortcutContext): void {
  const { store, run } = ctx;
  const s = store.getState();
  const tabs = run.scenarios;
  const at = tabs.findIndex((t) => t.id === run.scenario.id);
  const speeds = speedChoices(run.scenario.entry.speed);
  const speedAt = speeds.indexOf(s.speed);
  switch (hit.action) {
    case 'playPause':
      if (s.playing) store.pause();
      else if (playableAt(s.playheadMs, run.scenario.sim.shift) !== null) store.play();
      return;
    case 'reset':
      return store.reset();
    case 'jumpToLesson':
      return store.jumpToEntry();
    case 'prevTab':
    case 'nextTab': {
      const next = tabs[at + (hit.action === 'prevTab' ? -1 : 1)];
      if (next) run.select(next.id);
      return;
    }
    case 'goToTab': {
      const tab = tabs.find((t) => t.tab === hit.tab);
      if (tab) run.select(tab.id);
      return;
    }
    case 'toggleMode':
      return store.setMode(s.mode === 'live' ? 'highSide' : 'live');
    case 'slower':
    case 'faster': {
      // An off-preset speed steps to the nearest preset in that direction.
      const i =
        speedAt >= 0
          ? speedAt + (hit.action === 'slower' ? -1 : 1)
          : hit.action === 'slower'
            ? speeds.findLastIndex((v) => v < s.speed)
            : speeds.findIndex((v) => v > s.speed);
      const v = speeds[i];
      if (v !== undefined) store.setSpeed(v);
      return;
    }
    case 'toggleParameters':
      return ctx.setDrawerOpen(!ctx.drawerOpen);
    case 'trigger':
      return run.fork(run.scenario.trigger.patch, run.scenario.trigger.label);
    case 'toggleTheme':
      return toggleTheme();
    case 'help':
      return ctx.toggleHelp();
    case 'close':
      if (ctx.drawerOpen) ctx.setDrawerOpen(false);
      return;
  }
}

export function App(props: AppProps) {
  const scenarios = props.scenarios ?? defaultScenarios();
  const store = props.store ?? defaultStore();
  const calibration = props.calibration ?? appCalibration;
  const run = useScenarioRun(store, scenarios);
  const mode = usePlaybackSelector(store, selectMode);
  const [introOpen, setIntroOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useTheme();
  const helpRef = useRef<HTMLDivElement>(null);

  useShortcuts({
    helpOpen,
    helpDialog: () => helpRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null,
    run: (hit) =>
      runShortcut(hit, {
        store,
        run,
        drawerOpen,
        setDrawerOpen,
        toggleHelp: () => setHelpOpen((o) => !o),
      }),
  });

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
        toolbar={
          <ControlPanel
            store={store}
            run={run}
            drawerOpen={drawerOpen}
            onDrawerOpenChange={setDrawerOpen}
          />
        }
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
          />
        }
        sidebarActions={
          <HeaderActions
            theme={theme}
            onToggleTheme={toggleTheme}
            onShowShortcuts={() => setHelpOpen(true)}
            onShowIntro={() => setIntroOpen(true)}
          />
        }
      />
      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} contentRef={helpRef} />
      <IntroModal open={introOpen} onClose={() => setIntroOpen(false)} />
    </>
  );
}
