// Small decorative icons for toolbar buttons. Each button also has a text label, so the icons
// are aria-hidden.

import type { ReactNode } from 'react';

function Icon({ children, size = 12 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <Icon>
      <path d="M3 1.8v8.4L10 6z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PauseIcon() {
  return (
    <Icon>
      <path d="M3.5 2v8M8.5 2v8" strokeWidth="2" strokeLinecap="butt" />
    </Icon>
  );
}

/** Back to the lesson's entry point. */
export function JumpIcon() {
  return (
    <Icon>
      <path d="M2 2v8" />
      <path d="M10 2.5 4.5 6 10 9.5z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ResetIcon() {
  return (
    <Icon>
      <path d="M2.5 6a3.5 3.5 0 1 0 1.1-2.55" />
      <path d="M2.2 1.6v2.3h2.3" />
    </Icon>
  );
}

/** The tab's one-click trigger. */
export function TriggerIcon() {
  return (
    <Icon>
      <path d="M6.8 1 2.5 7h3l-.8 4L9.5 5h-3z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** A named fix. */
export function FixIcon() {
  return (
    <Icon>
      <path d="M2 6.5 4.8 9.2 10 3" />
    </Icon>
  );
}

export function SlidersIcon() {
  return (
    <Icon>
      <path d="M1.5 3.5h9M1.5 8.5h9" />
      <circle cx="4" cy="3.5" r="1.3" fill="var(--color-surface)" />
      <circle cx="8" cy="8.5" r="1.3" fill="var(--color-surface)" />
    </Icon>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Icon size={10}>
      <path d={open ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5'} />
    </Icon>
  );
}
