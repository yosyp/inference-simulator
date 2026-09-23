// The live status line (05 §8, K18): a polite live region that says what the engine is doing at
// the playhead. It updates at most STATUS_MAX_HZ times a second, so a screen reader isn't flooded
// while the week plays.

import { useCallback, useMemo } from 'react';
import type { PlaybackState, PlaybackStore, ResultsIndex } from '../../playback/types.ts';
import { usePlaybackSelector } from '../../playback/use-playback-selector.ts';
import type { StatusTemplate } from '../../scenarios/schema.ts';
import { byPriority, evaluateStatus } from './status.ts';

export const STATUS_MAX_HZ = 1;

// TODO(copy): shown when no template applies.
export const STATUS_FALLBACK = 'Nothing unusual at the moment.';

export interface StatusLineProps {
  store: PlaybackStore;
  templates: readonly StatusTemplate[];
  /** Most updates per second. Default STATUS_MAX_HZ. */
  maxHz?: number;
}

export function StatusLine({ store, templates, maxHz = STATUS_MAX_HZ }: StatusLineProps) {
  const sorted = useMemo(() => byPriority(templates), [templates]);
  const select = useCallback(
    (s: PlaybackState, index: ResultsIndex) =>
      evaluateStatus(sorted, index.statusAt(s.playheadMs), true)?.text ?? null,
    [sorted],
  );
  const text = usePlaybackSelector(store, select, { maxHz });
  return (
    <p
      aria-live="polite"
      aria-atomic="true"
      data-status={text === null ? 'none' : 'active'}
      className={text === null ? 'text-sm text-ink-subtle' : 'text-sm font-medium text-ink'}
    >
      {text ?? STATUS_FALLBACK}
    </p>
  );
}
