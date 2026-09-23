// Playback speed presets from 1× to 1000× (05 §5). Above DOTS_MAX_SPEED the canvas shows
// aggregate flow per replica instead of request dots; the legend beside the presets says which.

import { useMemo } from 'react';
import { DOTS_MAX_SPEED, clampSpeed, detailModeFor } from '../../playback/store.ts';
import type { PlaybackStore } from '../../playback/types.ts';
import { SegmentedToggle, type SegmentedOption } from '../primitives/SegmentedToggle.tsx';
import { cx } from '../primitives/util.ts';

export const SPEED_PRESETS: readonly number[] = [1, 5, 10, 50, 100, 1000];

/** The presets, plus the tab's entry speed if it isn't one of them. */
export function speedChoices(entrySpeed: number): number[] {
  const entry = clampSpeed(entrySpeed);
  return [...new Set([...SPEED_PRESETS, entry])].sort((a, b) => a - b);
}

export interface SpeedControlProps {
  store: PlaybackStore;
  speed: number;
  entrySpeed: number;
}

export function SpeedControl({ store, speed, entrySpeed }: SpeedControlProps) {
  const options = useMemo(
    (): SegmentedOption<string>[] =>
      speedChoices(entrySpeed).map((s) => ({
        value: String(s),
        label: `${s}×`,
        description:
          s <= DOTS_MAX_SPEED
            ? 'The canvas shows individual requests.'
            : 'The canvas shows aggregate flow per replica.',
      })),
    [entrySpeed],
  );
  const aggregate = detailModeFor(speed) === 'aggregate';
  return (
    <div className="flex items-center gap-1.5">
      <SegmentedToggle
        label="Playback speed"
        size="sm"
        options={options}
        value={String(speed)}
        onChange={(v) => store.setSpeed(Number(v))}
      />
      <span
        aria-hidden
        data-detail={aggregate ? 'aggregate' : 'dots'}
        className="flex flex-col text-2xs leading-3.5 whitespace-nowrap text-ink-subtle"
      >
        <span className={cx(!aggregate && 'font-semibold text-ink')}>Dots ≤{DOTS_MAX_SPEED}×</span>
        <span className={cx(aggregate && 'font-semibold text-ink')}>
          Flow &gt;{DOTS_MAX_SPEED}×
        </span>
      </span>
    </div>
  );
}
