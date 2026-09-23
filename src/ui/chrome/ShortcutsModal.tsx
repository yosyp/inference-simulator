// The keyboard-shortcut help (05 §10), opened with `?` or the header button.

import type { RefObject } from 'react';
import { Modal } from '../primitives/Modal.tsx';
import { SHORTCUT_ROWS } from './shortcuts.ts';

export const SHORTCUTS_TITLE = 'Keyboard shortcuts';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  /** Set to an element inside the dialog, so the key handler can tell it from other modals. */
  contentRef?: RefObject<HTMLDivElement | null>;
}

export function ShortcutsModal({ open, onClose, contentRef }: ShortcutsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={SHORTCUTS_TITLE}>
      <div ref={contentRef} className="flex flex-col gap-2">
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUT_ROWS.map((row) => (
              <tr key={row.label} className="border-b border-border last:border-b-0">
                <td className="py-1.5 pr-4 whitespace-nowrap">
                  {row.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="px-1 text-xs text-ink-subtle">or</span>}
                      <kbd className="rounded border border-border-strong bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                        {k}
                      </kbd>
                    </span>
                  ))}
                </td>
                <td className="py-1.5 text-ink-muted">{row.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-ink-subtle">
          Shortcuts are off while you type in a field or another dialog is open.
        </p>
      </div>
    </Modal>
  );
}
