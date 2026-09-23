// The playhead: the only part of the timeline that moves every frame. React renders it once (and
// again only when buffering flips); a frame subscription writes its `left` directly, so playback at
// 1000× moves it smoothly without re-rendering the bar (04 §3).

import { useLayoutEffect, useRef } from 'react';
import { subscribeFrame } from '../../playback/frame.ts';
import type { PlaybackStore } from '../../playback/types.ts';
import { cx } from '../primitives/util.ts';
import { leftPercent } from './geometry.ts';
import { PlayheadHandle } from './glyphs.tsx';

export interface PlayheadProps {
  store: PlaybackStore;
  buffering: boolean;
  hidden: boolean;
}

export function Playhead({ store, buffering, hidden }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = '';
    const place = (t: number) => {
      const left = leftPercent(t);
      if (left !== last) el.style.left = last = left;
    };
    place(store.getState().playheadMs);
    return subscribeFrame(store, (state) => place(state.playheadMs));
  }, [store]);

  return (
    <div
      ref={ref}
      hidden={hidden}
      aria-hidden
      data-part="playhead"
      data-buffering={buffering || undefined}
      className="pointer-events-none absolute top-0 left-0 h-[34px] w-0"
    >
      {/* The line crosses the bar; the knob sits on the computed strip (y = 28 px), clear of markers. */}
      <div className="absolute top-0 left-0 h-7 w-[1.5px] -translate-x-1/2 bg-series-playhead" />
      <div
        className={cx(
          'absolute top-7 left-0 flex -translate-x-1/2 -translate-y-1/2',
          buffering && 'animate-pulse',
        )}
      >
        <PlayheadHandle hollow={buffering} />
      </div>
    </div>
  );
}
