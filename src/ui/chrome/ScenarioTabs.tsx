// The six lesson tabs in teaching order (05 §3; 01 §6–§7). Manual activation: arrow keys move
// focus and Enter or Space selects, because selecting a tab resets its run (K16, K26).

import type { Scenario } from '../../scenarios/schema.ts';
import { Badge } from '../primitives/Badge.tsx';
import { Tabs, type TabItem } from '../primitives/Tabs.tsx';
import { Tooltip } from '../primitives/Tooltip.tsx';
import { presetLabel } from './params.ts';

export const SCENARIO_TABS_ID = 'lesson';

// TODO(copy): orientational tooltip for extrapolated presets (01 §7).
export const EXTRAPOLATED_TOOLTIP =
  'Scaled up from single-GPU measurements; not measured on this many replicas.';

export interface ScenarioTabsProps {
  /** In teaching order. */
  scenarios: readonly Scenario[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function ScenarioTabs({ scenarios, selectedId, onSelect }: ScenarioTabsProps) {
  const items: TabItem[] = scenarios.map((s) => ({ id: s.id, label: <TabLabel scenario={s} /> }));
  return (
    <Tabs
      id={SCENARIO_TABS_ID}
      label="Lessons"
      items={items}
      selectedId={selectedId}
      onSelect={onSelect}
      activation="manual"
    />
  );
}

function TabLabel({ scenario }: { scenario: Scenario }) {
  return (
    <span className="flex flex-col items-start gap-px py-1 text-left leading-tight">
      <span>
        <span className="tabular-nums">{scenario.tab}</span> {scenario.title}
        <span className="sr-only">, </span>
      </span>
      <span className="flex items-center gap-1 text-2xs font-normal text-ink-subtle">
        {presetLabel(scenario.preset)}
        {scenario.preset.basis === 'extrapolated' && (
          <>
            {' '}
            <ExtrapolatedBadge />
          </>
        )}
      </span>
    </span>
  );
}

/** The "Extrapolated" label (01 §7); the sidebar footnote repeats it in words for keyboard users. */
export function ExtrapolatedBadge() {
  return (
    <Tooltip content={EXTRAPOLATED_TOOLTIP} placement="bottom">
      <span>
        <Badge>Extrapolated</Badge>
      </span>
    </Tooltip>
  );
}
