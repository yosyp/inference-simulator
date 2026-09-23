import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
import { cx, ends, step } from './util.ts';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible description, e.g. what High side hides. */
  description?: string;
  disabled?: boolean;
}

export interface SegmentedToggleProps<T extends string> {
  /** Accessible name of the group, e.g. "Telemetry view". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A radio group drawn as joined buttons (Live / High side). One tab stop; arrow keys move and
 * select, Home and End jump to the ends (WAI-ARIA radio group).
 */
export function SegmentedToggle<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedToggleProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = (i: number) => options[i].disabled === true;
  const checkedIndex = options.findIndex((o) => o.value === value);
  // With nothing checked, the first enabled option takes the tab stop.
  const tabStop =
    checkedIndex >= 0 && !disabled(checkedIndex) ? checkedIndex : ends(options.length, disabled)[0];

  const select = (i: number) => {
    refs.current[i]?.focus();
    if (options[i].value !== value) onChange(options[i].value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const [first, last] = ends(options.length, disabled);
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      next = step(i, 1, options.length, disabled);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = step(i, -1, options.length, disabled);
    else if (e.key === 'Home') next = first;
    else if (e.key === 'End') next = last;
    if (next === null || next < 0) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        'inline-flex shrink-0 rounded border border-border-strong bg-surface p-0.5',
        className,
      )}
    >
      {options.map((o, i) => {
        const checked = i === checkedIndex;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-description={o.description}
            disabled={o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'rounded-sm font-medium whitespace-nowrap transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-sm',
              checked
                ? 'bg-ink text-surface'
                : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
