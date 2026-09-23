import type { ReactNode } from 'react';
import { cx } from './util.ts';

export interface BadgeProps {
  /** neutral: labels like "Extrapolated". warn: caveats like "Provisional calibration". */
  tone?: 'neutral' | 'warn';
  children: ReactNode;
  className?: string;
}

/** A small inline label. Text, not color, carries its meaning. */
export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-sm border px-1 text-2xs font-medium',
        tone === 'warn'
          ? 'border-warn-border bg-warn-bg text-warn-ink'
          : 'border-border bg-surface-muted text-ink-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
