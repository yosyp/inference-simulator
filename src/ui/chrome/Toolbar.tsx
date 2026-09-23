// The toolbar (05 §4, K16): always-visible playback and scenario controls in two rows.
// Playback: play/pause, speed, jump to the lesson, Reset, and an end-of-week note. The playhead
// clock and the buffering indicator live on the week timeline (U5), not here. Scenario: the
// trigger, the named fix (tabs 4 and 6), the Live / High-side toggle, and the parameters drawer
// toggle.

import { useCallback } from 'react';
import type { PatchTemplate, TunableParams } from '../../engine/api.ts';
import { playableAt } from '../../playback/shift.ts';
import type { Mode, PlaybackState, PlaybackStore } from '../../playback/types.ts';
import { usePlaybackSelector } from '../../playback/use-playback-selector.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import { Button } from '../primitives/Button.tsx';
import { DrawerToggle } from '../primitives/Drawer.tsx';
import { SegmentedToggle, type SegmentedOption } from '../primitives/SegmentedToggle.tsx';
import {
  ChevronIcon,
  FixIcon,
  JumpIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  SlidersIcon,
  TriggerIcon,
} from './icons.tsx';
import { changesHold } from './params.ts';
import { SpeedControl } from './SpeedControl.tsx';

export interface ToolbarProps {
  store: PlaybackStore;
  scenario: Scenario;
  /** Parameters in effect at the playhead (useParamsInEffect). */
  params: TunableParams;
  onFork: (template: PatchTemplate, label: string) => void;
  drawer: { id: string; open: boolean; onToggle: () => void };
}

interface View {
  playing: boolean;
  speed: number;
  mode: Mode;
  /** The playhead is past Friday's shift, so Play has nothing left to play. */
  ended: boolean;
}

const sameView = (a: View, b: View) =>
  a.playing === b.playing && a.speed === b.speed && a.mode === b.mode && a.ended === b.ended;

// TODO(copy): the High-side descriptions are orientational; 05 §9 has the full contrast.
const MODE_OPTIONS: readonly SegmentedOption<Mode>[] = [
  { value: 'live', label: 'Live', description: 'Everything the simulator knows, as it happens.' },
  {
    value: 'highSide',
    label: 'High side',
    description: 'Only the daily rollup an off-site team receives, a day late.',
  },
];

export function Toolbar({ store, scenario, params, onFork, drawer }: ToolbarProps) {
  const shift = scenario.sim.shift;
  const select = useCallback(
    (s: PlaybackState): View => ({
      playing: s.playing,
      speed: s.speed,
      mode: s.mode,
      ended: playableAt(s.playheadMs, shift) === null,
    }),
    [shift],
  );
  const view = usePlaybackSelector(store, select, { equals: sameView });
  const { trigger, namedFix } = scenario;
  const fixInEffect = namedFix ? changesHold(params, namedFix.changes) : false;

  return (
    <div className="flex flex-col divide-y divide-border">
      <div role="group" aria-label="Playback" className={rowClass}>
        <Button
          variant="primary"
          size="sm"
          className="w-20"
          disabled={!view.playing && view.ended}
          onClick={() => (view.playing ? store.pause() : store.play())}
        >
          {view.playing ? <PauseIcon /> : <PlayIcon />}
          {view.playing ? 'Pause' : 'Play'}
        </Button>
        <SpeedControl speed={view.speed} entrySpeed={scenario.entry.speed} store={store} />
        <Button
          size="sm"
          {...hint(`Back to the start of the lesson, paused: ${scenario.lessonMoment.label}`)}
          onClick={() => store.jumpToEntry()}
        >
          <JumpIcon />
          Jump to lesson
        </Button>
        <Button
          size="sm"
          {...hint('Start this tab over. Your changes are discarded.')}
          onClick={() => store.reset()}
        >
          <ResetIcon />
          Reset
        </Button>
        {view.ended && (
          <span className="ml-auto pl-2 text-xs text-ink-subtle">End of the week</span>
        )}
      </div>
      <div role="group" aria-label="Scenario" className={rowClass}>
        <Button
          size="sm"
          {...hint("Applies this tab's change at the playhead. The run forks there.")}
          onClick={() => onFork(trigger.patch, trigger.label)}
        >
          <TriggerIcon />
          {trigger.label}
        </Button>
        {namedFix && (
          <Button
            size="sm"
            {...hint(
              fixInEffect
                ? 'This fix is in effect at the playhead.'
                : 'Applies the fix at the playhead. The run forks there.',
            )}
            onClick={() => onFork({ kind: 'set', changes: namedFix.changes }, namedFix.label)}
          >
            <FixIcon />
            {namedFix.label}
            {fixInEffect && <span className="text-2xs font-normal text-ink-subtle">(on)</span>}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2 pl-2">
          <SegmentedToggle
            label="Telemetry view"
            size="sm"
            options={MODE_OPTIONS}
            value={view.mode}
            onChange={(mode) => store.setMode(mode)}
          />
          <DrawerToggle
            drawerId={drawer.id}
            open={drawer.open}
            onToggle={drawer.onToggle}
            size="sm"
          >
            <SlidersIcon />
            Parameters
            <ChevronIcon open={drawer.open} />
          </DrawerToggle>
        </div>
      </div>
    </div>
  );
}

/**
 * An orientational hint (05 §10) that never covers other controls: a native title on hover and
 * an accessible description. The Tooltip primitive stays open while its button keeps focus after
 * a click and catches pointer events, so under the tabs it blocks the next tab click.
 */
function hint(text: string) {
  return { title: text, 'aria-description': text };
}

const rowClass = 'flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1';
