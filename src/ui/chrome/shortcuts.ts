// Keyboard shortcuts (05 §10): one table drives both the key handling and the help modal's list.

import { useEffect, useRef } from 'react';

export type ShortcutAction =
  | 'playPause'
  | 'reset'
  | 'jumpToLesson'
  | 'prevTab'
  | 'nextTab'
  | 'goToTab'
  | 'toggleMode'
  | 'slower'
  | 'faster'
  | 'toggleParameters'
  | 'trigger'
  | 'toggleTheme'
  | 'help'
  | 'close';

export interface ShortcutRow {
  /** Keys as shown in the help modal. */
  keys: readonly string[];
  label: string;
}

/** The help modal's list, in toolbar order. */
export const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  { keys: ['Space'], label: 'Play or pause' },
  { keys: ['-', '='], label: 'Slower or faster speed' },
  { keys: ['j'], label: 'Jump to the lesson' },
  { keys: ['r'], label: 'Reset the tab' },
  { keys: ['t'], label: "Fire the tab's trigger" },
  { keys: ['h'], label: 'Switch between Live and High side' },
  { keys: ['p'], label: 'Open or close the parameters' },
  { keys: ['[', ']'], label: 'Previous or next tab (also Shift+← and Shift+→)' },
  { keys: ['1–6'], label: 'Go to a tab' },
  { keys: ['d'], label: 'Dark or light theme' },
  { keys: ['?'], label: 'Show these shortcuts' },
  { keys: ['Esc'], label: 'Close a dialog or the parameters' },
];

export interface ShortcutHit {
  action: ShortcutAction;
  /** For goToTab: the tab number. */
  tab?: number;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/** The action a key press maps to, or null. */
export function shortcutFor(e: KeyLike): ShortcutHit | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.shiftKey && e.key === 'ArrowLeft') return { action: 'prevTab' };
  if (e.shiftKey && e.key === 'ArrowRight') return { action: 'nextTab' };
  if (/^[1-9]$/.test(e.key)) return { action: 'goToTab', tab: Number(e.key) };
  switch (e.key) {
    case ' ':
      return { action: 'playPause' };
    case 'r':
      return { action: 'reset' };
    case 'j':
      return { action: 'jumpToLesson' };
    case '[':
      return { action: 'prevTab' };
    case ']':
      return { action: 'nextTab' };
    case 'h':
      return { action: 'toggleMode' };
    case '-':
    case '_':
      return { action: 'slower' };
    case '=':
    case '+':
      return { action: 'faster' };
    case 'p':
      return { action: 'toggleParameters' };
    case 't':
      return { action: 'trigger' };
    case 'd':
      return { action: 'toggleTheme' };
    case '?':
      return { action: 'help' };
    case 'Escape':
      return { action: 'close' };
    default:
      return null;
  }
}

const TYPING = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]';
/** Controls that act on Space themselves, or on arrows (the timeline slider, tabs, toggles). */
const OWNS_KEYS =
  'button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="menuitem"], [role="option"]';

/**
 * Whether the page should leave this key to the focused element: typing in a field, Space on a
 * control that it activates, and arrows on a slider or other arrow-driven control.
 */
export function leaveToTarget(key: string, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TYPING)) return true;
  const owns = target.closest(OWNS_KEYS) !== null;
  return owns && (key === ' ' || key.startsWith('Arrow'));
}

/** An open modal dialog other than `except`. */
function otherModalOpen(except: HTMLElement | null): boolean {
  for (const d of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    if (d !== except && !except?.contains(d)) return true;
  }
  return false;
}

export interface ShortcutOptions {
  /** Whether the help modal is open; then only `?` works (Escape is the modal's). */
  helpOpen: boolean;
  /** The help dialog element, which doesn't count as "another modal". */
  helpDialog: () => HTMLElement | null;
  run: (hit: ShortcutHit) => void;
}

/** Listens on the window for the shortcuts in SHORTCUT_ROWS. */
export function useShortcuts(options: ShortcutOptions): void {
  const ref = useRef(options);
  useEffect(() => {
    ref.current = options;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const hit = shortcutFor(e);
      if (!hit) return;
      const { helpOpen, helpDialog, run } = ref.current;
      if (helpOpen) {
        if (hit.action !== 'help') return;
      } else {
        if (otherModalOpen(helpDialog())) return;
        if (leaveToTarget(e.key, e.target)) return;
      }
      if (hit.action !== 'close') e.preventDefault();
      run(hit);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
