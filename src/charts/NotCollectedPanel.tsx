// The High-side empty panel (05 §9): a hatched plot area that says the metric is not collected.

import { ChartHeader } from './ChartHeader.tsx';
import { PLOT_INSET, PLOT_PAD } from './layout.ts';

export const NOT_COLLECTED_MESSAGE = 'Not collected on the high side';

export interface NotCollectedPanelProps {
  message?: string;
  /** The chart's title, kept so the slot still says what would be here. */
  title?: string;
  /** Total height, title row included; omit to fill the parent. */
  height?: number;
}

export function NotCollectedPanel({
  message = NOT_COLLECTED_MESSAGE,
  title,
  height,
}: NotCollectedPanelProps) {
  return (
    <div
      role="group"
      aria-label={title ? `${title}: ${message}` : message}
      data-chart="notCollected"
      className="flex flex-col"
      style={{ height: height ?? '100%' }}
    >
      {title && <ChartHeader title={title} entries={[]} />}
      <div
        className="flex min-h-0 flex-1"
        style={{
          paddingLeft: PLOT_INSET.left,
          paddingRight: PLOT_INSET.right,
          paddingTop: title ? PLOT_PAD.top : 0,
          paddingBottom: PLOT_PAD.bottom,
        }}
      >
        <div className="bg-hatch flex flex-1 items-center justify-center rounded-sm text-xs text-high-side-empty-ink">
          <p>{message}</p>
        </div>
      </div>
    </div>
  );
}
