// Throttled React access to the playback store (04 §3): the playhead changes every frame, but
// components re-render at most maxHz times a second.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { throttle } from './throttle.ts';
import type { PlaybackState, PlaybackStore, ResultsIndex } from './types.ts';

export const DEFAULT_SELECTOR_HZ = 10;

export interface SelectorOptions<T> {
  /** Most re-renders per second. Default 10. */
  maxHz?: number;
  /** When a new selection equals the previous one, the previous is kept. Default Object.is. */
  equals?: (a: T, b: T) => boolean;
}

type Selector<T> = (state: PlaybackState, index: ResultsIndex) => T;

interface Cache<T> {
  state: PlaybackState;
  version: number;
  selector: Selector<T>;
  value: T;
}

/**
 * Selects from the playback state (and the results index, whose `version` also triggers updates).
 * The selection is recomputed only when the state or the index version changes, and components
 * hear about changes at most maxHz times a second, with a trailing update for the last change.
 */
export function usePlaybackSelector<T>(
  store: PlaybackStore,
  selector: Selector<T>,
  options: SelectorOptions<T> = {},
): T {
  const maxHz = options.maxHz ?? DEFAULT_SELECTOR_HZ;
  const equals = options.equals ?? Object.is;
  const cache = useRef<Cache<T> | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const throttled = throttle(onChange, 1000 / maxHz);
      const unsubscribe = store.subscribe(throttled.call);
      return () => {
        throttled.cancel();
        unsubscribe();
      };
    },
    [store, maxHz],
  );

  const getSnapshot = (): T => {
    const state = store.getState();
    const index = store.index;
    const c = cache.current;
    if (c && c.state === state && c.version === index.version && c.selector === selector) {
      return c.value;
    }
    const next = selector(state, index);
    const value = c && equals(c.value, next) ? c.value : next;
    cache.current = { state, version: index.version, selector, value };
    return value;
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
