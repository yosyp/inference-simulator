// The toolbar slot's content: the lesson tab panel holding the toolbar and, under it, the inline
// parameters drawer (05 §4, K26).

import { useState } from 'react';
import type { PlaybackStore } from '../../playback/types.ts';
import { TabPanel } from '../primitives/Tabs.tsx';
import { ParametersDrawer } from './ParametersDrawer.tsx';
import { SCENARIO_TABS_ID } from './ScenarioTabs.tsx';
import { Toolbar } from './Toolbar.tsx';
import { useParamsInEffect, type ScenarioRun } from './use-scenario-run.ts';

export const PARAMETERS_DRAWER_ID = 'parameters-drawer';

export interface ControlPanelProps {
  store: PlaybackStore;
  run: ScenarioRun;
  /** Controls the parameters drawer (the `p` shortcut). Omit both to let the panel own it. */
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
}

export function ControlPanel({ store, run, ...controlled }: ControlPanelProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const drawerOpen = controlled.drawerOpen ?? ownOpen;
  const setDrawerOpen = controlled.onDrawerOpenChange ?? setOwnOpen;
  const { scenario } = run;
  const params = useParamsInEffect(store, scenario, run.applied);
  return (
    <TabPanel tabsId={SCENARIO_TABS_ID} selectedId={scenario.id}>
      <Toolbar
        store={store}
        scenario={scenario}
        params={params}
        onFork={run.fork}
        drawer={{
          id: PARAMETERS_DRAWER_ID,
          open: drawerOpen,
          onToggle: () => setDrawerOpen(!drawerOpen),
        }}
      />
      <ParametersDrawer
        // A new tab starts with no half-dragged slider.
        key={scenario.id}
        id={PARAMETERS_DRAWER_ID}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        params={scenario.drawer}
        values={params}
        onChange={(changes, label) => run.fork({ kind: 'set', changes }, label)}
      />
    </TabPanel>
  );
}
