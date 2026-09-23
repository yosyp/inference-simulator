import { viewport } from '../theme/layout.ts';
import type { ViewportSize } from './useViewport.ts';

/** Asks for a larger window below 1280×720 (K15). The page stays usable by scrolling. */
export function ViewportNotice({ size }: { size: ViewportSize }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warn-border bg-warn-bg px-4 py-2 text-sm text-warn-ink"
    >
      <strong className="font-semibold">Please use a larger window.</strong> This simulator needs at
      least {viewport.minWidthPx} × {viewport.minHeightPx}; this window is{' '}
      <span className="tabular-nums">
        {size.widthPx} × {size.heightPx}
      </span>
      . Enlarge the window or zoom out (Ctrl or ⌘ and −).
    </div>
  );
}
