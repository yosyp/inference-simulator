// Pointer and keyboard seeking for the timeline slider. Seeks go straight to store.seek, which leaves
// `playing` alone, so scrubbing while playing keeps playing from the new time.

import type { KeyboardEvent, PointerEvent } from 'react';
import { useRef } from 'react';
import type { Shift } from '../../playback/shift.ts';
import type { PlaybackStore } from '../../playback/types.ts';
import { keyTarget, snapToShift, timeAtClientX } from './geometry.ts';

interface Drag {
  pointerId: number;
  rect: { left: number; width: number };
}

export interface ScrubHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

/** Handlers for the slider element. `shift` is null until a scenario loads; nothing seeks before. */
export function useScrub(store: PlaybackStore, shift: Shift | null): ScrubHandlers {
  const drag = useRef<Drag | null>(null);

  const seekAt = (clientX: number, rect: Drag['rect']) => {
    const t = timeAtClientX(clientX, rect);
    if (t !== null && shift) store.seek(snapToShift(t, shift));
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
    const el = e.currentTarget;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  return {
    onPointerDown(e) {
      if (!shift || e.button !== 0) return;
      const el = e.currentTarget;
      const { left, width } = el.getBoundingClientRect();
      if (!(width > 0)) return;
      // Keep focus on the slider (so the keys work next) and stop text selection while dragging.
      e.preventDefault();
      el.focus();
      drag.current = { pointerId: e.pointerId, rect: { left, width } };
      el.setPointerCapture?.(e.pointerId);
      seekAt(e.clientX, drag.current.rect);
    },
    onPointerMove(e) {
      const d = drag.current;
      if (d && d.pointerId === e.pointerId) seekAt(e.clientX, d.rect);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onKeyDown(e) {
      if (!shift || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = keyTarget(e, store.getState().playheadMs, shift);
      if (target === null) return;
      e.preventDefault();
      store.seek(target);
    },
  };
}
