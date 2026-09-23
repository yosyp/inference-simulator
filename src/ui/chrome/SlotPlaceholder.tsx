// A labelled stand-in for a slot another WP fills (canvas U3, charts U4, timeline U5, rollup U7).
// X1 replaces each use with the real component.

import { cx } from '../primitives/util.ts';

export interface SlotPlaceholderProps {
  title: string;
  /** The work package that fills this slot. */
  owner: string;
  detail?: string;
  className?: string;
}

export function SlotPlaceholder({ title, owner, detail, className }: SlotPlaceholderProps) {
  return (
    <div
      data-placeholder={owner}
      className={cx(
        'flex flex-col items-center justify-center gap-0.5 rounded border border-dashed',
        'border-border-strong bg-bg p-2 text-center text-xs text-ink-subtle',
        className,
      )}
    >
      <span className="font-medium text-ink-muted">{title}</span>
      {detail && <span>{detail}</span>}
      <span className="text-2xs">Placeholder until {owner} lands</span>
    </div>
  );
}
