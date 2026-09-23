// The rollup rows the off-site team holds at the playhead, for React (05 §9). Throttled like the
// other store selectors, and stable between arrivals: the result changes only when the playhead
// crosses a 12:00 delivery or a midnight, or the engine delivers or discards a day's rollup, so
// the table re-renders a few times a week of play, not every frame.

import type { PlaybackState, PlaybackStore, ResultsIndex } from '../../playback/types.ts';
import { DEFAULT_SELECTOR_HZ, usePlaybackSelector } from '../../playback/use-playback-selector.ts';
import {
  deliveredRollupAt,
  rollupRowsOf,
  sameDelivered,
  type DeliveredRollup,
} from './delivered.ts';

/** Same rate as ChartStack's selector, so the table and the daily bars change together. */
export const ROLLUP_MAX_HZ = DEFAULT_SELECTOR_HZ;

export interface DeliveredRollupOptions {
  /** Most re-renders per second. Default ROLLUP_MAX_HZ. */
  maxHz?: number;
}

export function selectDeliveredRollup(state: PlaybackState, index: ResultsIndex): DeliveredRollup {
  return deliveredRollupAt(rollupRowsOf(index), state.playheadMs, index.replicas);
}

/** Rows delivered by the playhead (deliveredAtMs ≤ playhead) and the days still pending. */
export function useDeliveredRollup(
  store: PlaybackStore,
  options: DeliveredRollupOptions = {},
): DeliveredRollup {
  return usePlaybackSelector(store, selectDeliveredRollup, {
    maxHz: options.maxHz ?? ROLLUP_MAX_HZ,
    equals: sameDelivered,
  });
}
