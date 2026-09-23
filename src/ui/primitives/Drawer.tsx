import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { chromeTransition, usePrefersReducedMotion } from '../theme/motion.ts';
import type { ButtonProps } from './Button.tsx';
import { Button } from './Button.tsx';
import { cx } from './util.ts';

export interface DrawerProps {
  /** DOM id; the matching <DrawerToggle drawerId> points at it. */
  id: string;
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

function toggleFor(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[aria-controls]')) {
    if (el.getAttribute('aria-controls') === id) return el;
  }
  return null;
}

/**
 * A non-modal panel that slides open in place, such as the parameters drawer under the toolbar
 * (05 §4). Opening moves focus into it; Escape closes it; closing returns focus to its toggle if
 * focus was inside.
 */
export function Drawer({ id, open, onClose, title, children, className }: DrawerProps) {
  const reduced = usePrefersReducedMotion();
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const panel = panelRef.current;
    if (open) panel?.focus();
    else if (panel?.contains(document.activeElement)) toggleFor(id)?.focus();
  }, [open, id]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  const titleId = `${id}-title`;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.section
          key="drawer"
          ref={panelRef}
          id={id}
          tabIndex={-1}
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={chromeTransition(reduced)}
          className={cx(
            'overflow-hidden border-b border-border bg-surface focus-visible:-outline-offset-2',
            className,
          )}
        >
          <div className="flex flex-col gap-2 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <h2 id={titleId} className="text-xs font-semibold text-ink-muted">
                {title}
              </h2>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
            {children}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

export interface DrawerToggleProps extends Omit<ButtonProps, 'pressed' | 'onClick'> {
  drawerId: string;
  open: boolean;
  onToggle: () => void;
}

/** The button that opens and closes a <Drawer>. */
export function DrawerToggle({ drawerId, open, onToggle, className, ...rest }: DrawerToggleProps) {
  return (
    <Button
      aria-expanded={open}
      aria-controls={drawerId}
      onClick={onToggle}
      className={cx('aria-expanded:border-ink aria-expanded:bg-surface-muted', className)}
      {...rest}
    />
  );
}
