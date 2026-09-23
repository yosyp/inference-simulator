// Per-frame access for the canvas (U3), outside React (04 §3; CLAUDE.md: the canvas draws the state
// at the playhead as a pure function of simulated time).

import {
  FRAME_SOURCE,
  detailModeFor,
  type EngineClientStore,
  type FrameListener,
} from './store.ts';
import { browserFrames, type FrameScheduler } from './timing.ts';
import type { PlaybackState, PlaybackStore, ResultsIndex, SceneState } from './types.ts';

/**
 * Calls back once per animation frame while the store is playing, and on the next frame after any
 * other change (seek, mode, new results), plus once right after subscribing. With createPlaybackStore
 * the callback runs in the store's own frame, right after the playhead advances. Any other
 * PlaybackStore falls back to coalescing its notifications onto `frames`.
 */
export function subscribeFrame(
  store: PlaybackStore,
  callback: FrameListener,
  frames?: FrameScheduler,
): () => void {
  const source = (store as Partial<EngineClientStore>)[FRAME_SOURCE];
  if (typeof source === 'function') return source.call(store, callback);

  const scheduler = frames ?? browserFrames();
  let handle: number | null = null;
  const run = () => {
    handle = null;
    callback(store.getState(), store.index);
  };
  const schedule = () => {
    if (handle === null) handle = scheduler.request(run);
  };
  const unsubscribe = store.subscribe(schedule);
  schedule();
  return () => {
    unsubscribe();
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
  };
}

/** The canvas input at the playhead: detail follows the speed threshold (05 §5). */
export function sceneAtPlayhead(state: PlaybackState, index: ResultsIndex): SceneState {
  return index.sceneAt(state.playheadMs, {
    mode: state.mode,
    detail: detailModeFor(state.speed),
    trackedAnalyst: state.trackedAnalyst,
  });
}
