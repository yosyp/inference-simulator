// A chart's title row: the title, the legend-readout (values lead, labels follow), and a note.

import type { ReactNode } from 'react';
import { STACK_ROWS } from './layout.ts';
import type { LegendEntry, Swatch } from './readout.ts';
import { dashArray } from './styles.ts';

function SwatchIcon({ swatch }: { swatch: Swatch }) {
  if (swatch.kind === 'none') return null;
  let mark: ReactNode;
  switch (swatch.kind) {
    case 'line':
      mark = (
        <line
          x1={1}
          x2={15}
          y1={5}
          y2={5}
          stroke={swatch.style.color}
          strokeWidth={Math.max(1.5, swatch.style.widthPx)}
          strokeDasharray={dashArray(swatch.style)}
        />
      );
      break;
    case 'dot':
      mark = <circle cx={8} cy={5} r={3} fill={swatch.color} />;
      break;
    case 'ring':
      mark = <circle cx={8} cy={5} r={3} fill="none" stroke={swatch.color} strokeWidth={1.5} />;
      break;
    case 'bar':
      mark = <rect x={4} y={0} width={8} height={10} rx={1.5} fill={swatch.color} />;
      break;
    case 'tick':
      mark = <line x1={8} x2={8} y1={0} y2={10} stroke={swatch.color} strokeWidth={1.5} />;
      break;
  }
  return (
    <svg width={16} height={10} aria-hidden className="shrink-0">
      {mark}
    </svg>
  );
}

export interface ChartHeaderProps {
  title: string;
  entries: readonly LegendEntry[];
  note?: string | null;
  /** Right-aligned content, e.g. the zoom controls on the top chart. */
  children?: ReactNode;
}

export function ChartHeader({ title, entries, note, children }: ChartHeaderProps) {
  return (
    <div
      className="flex items-center gap-3 overflow-hidden px-2 text-2xs whitespace-nowrap text-ink-muted"
      style={{ height: STACK_ROWS.headerPx }}
    >
      <span className="font-semibold text-ink">{title}</span>
      <ul className="flex min-w-0 items-center gap-3" aria-label={`${title} values`}>
        {entries.map((e) => (
          <li key={e.id} className="flex items-center gap-1" data-legend={e.id}>
            <SwatchIcon swatch={e.swatch} />
            <span className="font-medium text-ink tabular-nums">{e.value}</span>
            <span>{e.label}</span>
          </li>
        ))}
      </ul>
      {note && <span className="ml-auto min-w-0 truncate text-ink-subtle">{note}</span>}
      {children}
    </div>
  );
}
