import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { chromeTransition, usePrefersReducedMotion } from '../theme/motion.ts';
import { Button } from './Button.tsx';
import { cx, tabbables } from './util.ts';

export interface ModalProps {
  open: boolean;
  /** Called on Escape, the close button, and (by default) a backdrop click. */
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Focused on open. Defaults to the first tabbable element in the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Default true. */
  closeOnBackdrop?: boolean;
  /** Hide the corner close button when the content has its own, e.g. "Start exploring". */
  hideCloseButton?: boolean;
  className?: string;
}

/**
 * A modal dialog (the intro modal, 05 §2). Focus moves in on open and is trapped: Tab and
 * Shift+Tab wrap. Escape closes. On close, focus returns to where it was before opening.
 * Keep it mounted and toggle `open`, so the return of focus happens on close.
 */
export function Modal({ open, ...panel }: ModalProps) {
  const reduced = usePrefersReducedMotion();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={chromeTransition(reduced, 'fast')}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          // Keep focus in the dialog when the backdrop is pressed.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) e.preventDefault();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && panel.closeOnBackdrop !== false) panel.onClose();
          }}
        >
          <ModalPanel {...panel} reduced={reduced} returnFocusRef={returnFocusRef} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ModalPanelProps extends Omit<ModalProps, 'open'> {
  reduced: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}

function ModalPanel({
  onClose,
  title,
  children,
  initialFocusRef,
  hideCloseButton,
  className,
  reduced,
  returnFocusRef,
}: ModalPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const active = document.activeElement;
    // StrictMode runs this twice on mount; the second run finds focus already inside the dialog.
    if (!el.contains(active)) {
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    (initialFocusRef?.current ?? tabbables(el)[0] ?? el).focus();
  }, [initialFocusRef, returnFocusRef]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const el = panelRef.current;
    if (e.key !== 'Tab' || !el) return;
    const items = tabbables(el);
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!first || !last) {
      e.preventDefault();
      el.focus();
    } else if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      initial={reduced ? false : { y: 8 }}
      animate={{ y: 0 }}
      transition={chromeTransition(reduced)}
      className={cx(
        'relative flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-md',
        'border border-border bg-surface p-5 text-ink shadow-lg focus-visible:outline-none',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {!hideCloseButton && (
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="-mr-2">
            <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </Button>
        )}
      </div>
      {children}
    </motion.div>
  );
}
