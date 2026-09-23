import type { ComponentPropsWithRef } from 'react';
import { cx } from './util.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** primary: the one main action in a group. secondary: default. ghost: low-emphasis, icon-like. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Makes a toggle button (aria-pressed), e.g. play/pause or a drawer toggle. */
  pressed?: boolean;
}

const base =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap ' +
  'select-none transition-colors disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-surface hover:bg-ink-muted border border-ink',
  secondary:
    'bg-surface text-ink border border-border-strong hover:bg-surface-muted ' +
    'aria-pressed:bg-surface-muted aria-pressed:border-ink',
  ghost:
    'bg-transparent text-ink-muted border border-transparent hover:bg-surface-muted ' +
    'hover:text-ink aria-pressed:bg-surface-muted aria-pressed:text-ink',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
};

/** A native button with the design system's variants. Defaults to type="button". */
export function Button({
  variant = 'secondary',
  size = 'md',
  pressed,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cx(base, variants[variant], sizes[size], className)}
      {...rest}
    />
  );
}
