// The collapsible home of the High-side rollup table (05 §8, §9; K17). U7 fills it; the table
// reaches 120 cells on Server B, so it collapses.

import { useId, useState, type ReactNode } from 'react';
import { ChevronIcon } from '../chrome/icons.tsx';

export interface RollupSectionProps {
  children: ReactNode;
  /** Default true. */
  defaultOpen?: boolean;
}

export function RollupSection({ children, defaultOpen = true }: RollupSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const bodyId = `${id}-body`;
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="-mx-1 inline-flex items-center gap-1.5 rounded px-1 hover:bg-surface-muted"
        >
          Daily rollup
          <ChevronIcon open={open} />
        </button>
      </h3>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
