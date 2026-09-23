import type { ReactNode } from 'react';
import type { Mode } from '../../playback/types.ts';
import { isViewportTooSmall } from '../theme/layout.ts';
import { ViewportNotice } from './ViewportNotice.tsx';
import { useViewport } from './useViewport.ts';

export interface AppShellProps {
  /** Scenario tabs (U6). */
  tabs: ReactNode;
  /** Trigger, Live/High-side toggle, playback, Reset, and the parameters drawer (U6). */
  toolbar: ReactNode;
  /** The simulation canvas (U3). The slot has a fixed height and is position: relative. */
  canvas: ReactNode;
  /** The three stacked charts (U4). */
  charts: ReactNode;
  /** The week timeline (U5). Pinned under the scrolling area so scrubbing is always in reach. */
  timeline: ReactNode;
  /** Tab text, live status, rollup table, footnote (U6). */
  sidebar: ReactNode;
  /** Sets data-mode on the shell and marks the High-side view with a top rule. */
  mode?: Mode;
  /** Accessible name of the sidebar landmark. */
  sidebarLabel?: string;
}

/**
 * The page frame (05 §1, K15): a 70/30 split between the simulator column and the sidebar.
 * Tabs and toolbar stay at the top and the timeline at the bottom; the canvas and charts scroll
 * between them when the window is shorter than the 1440×900 design target. Below 1280×720 the
 * frame stops shrinking, the page scrolls, and a notice asks for a larger window.
 */
export function AppShell({
  tabs,
  toolbar,
  canvas,
  charts,
  timeline,
  sidebar,
  mode = 'live',
  sidebarLabel = 'About this tab',
}: AppShellProps) {
  const size = useViewport();
  const tooSmall = isViewportTooSmall(size.widthPx, size.heightPx);

  return (
    <div
      data-mode={mode}
      className="flex h-dvh min-h-[720px] min-w-[1280px] flex-col bg-bg text-ink"
    >
      {tooSmall && <ViewportNotice size={size} />}
      <div className="grid min-h-0 flex-1 grid-cols-[7fr_3fr]">
        <main aria-label="Simulator" className="flex min-h-0 min-w-0 flex-col">
          {mode === 'highSide' && (
            <div aria-hidden className="h-0.5 shrink-0 bg-mode-high-side" data-slot="mode-rule" />
          )}
          <header
            data-slot="tabs"
            className="flex min-h-(--layout-tabs-h) shrink-0 items-stretch border-b border-border bg-surface px-2"
          >
            {tabs}
          </header>
          <div
            data-slot="toolbar"
            className="min-h-(--layout-toolbar-h) shrink-0 border-b border-border bg-surface"
          >
            {toolbar}
          </div>
          <div data-slot="scroll" className="min-h-0 flex-1 overflow-y-auto bg-surface">
            <section
              aria-label="Simulation"
              data-slot="canvas"
              className="relative h-(--layout-canvas-h) border-b border-border bg-canvas-bg"
            >
              {canvas}
            </section>
            <section aria-label="Charts" data-slot="charts" className="bg-surface">
              {charts}
            </section>
          </div>
          <section
            aria-label="Week timeline"
            data-slot="timeline"
            className="min-h-(--layout-timeline-h) shrink-0 border-t border-border bg-surface"
          >
            {timeline}
          </section>
        </main>
        <aside
          aria-label={sidebarLabel}
          data-slot="sidebar"
          className="min-h-0 min-w-0 overflow-y-auto border-l border-border bg-surface"
        >
          {sidebar}
        </aside>
      </div>
    </div>
  );
}
