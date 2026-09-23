import type { ReactElement, ReactNode } from 'react';
import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './util.ts';

export interface TooltipProps {
  /** Orientational text only: what a control or element is (05 §10). */
  content: ReactNode;
  /** One focusable element, which gets aria-describedby. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom';
  /** Hover delay before showing. Focus shows at once. */
  delayMs?: number;
}

interface Anchor {
  x: number;
  y: number;
  align: 'start' | 'center' | 'end';
}

const EDGE_PX = 160;
const HIDE_DELAY_MS = 80;

/**
 * Shows `content` while its child is hovered or focused. Escape dismisses it (WCAG 1.4.13), and the
 * pointer can move onto it. Rendered in a portal so scroll containers don't clip it.
 */
export function Tooltip({ content, children, placement = 'top', delayMs = 400 }: TooltipProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const open = (hovered || focused) && !dismissed;

  const measure = () => {
    const el = wrapperRef.current?.firstElementChild;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const align = cx < EDGE_PX ? 'start' : cx > window.innerWidth - EDGE_PX ? 'end' : 'center';
    const x = align === 'start' ? r.left : align === 'end' ? r.right : cx;
    setAnchor({ x, y: placement === 'top' ? r.top : r.bottom, align });
  };

  const clearTimer = () => window.clearTimeout(timer.current);
  const show = (via: 'hover' | 'focus') => {
    clearTimer();
    measure();
    setDismissed(false);
    if (via === 'focus') setFocused(true);
    else timer.current = window.setTimeout(() => setHovered(true), delayMs);
  };
  const hideHover = () => {
    clearTimer();
    timer.current = window.setTimeout(() => setHovered(false), HIDE_DELAY_MS);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    const onScroll = () => setDismissed(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');
  const translateX = { start: '0', center: '-50%', end: '-100%' }[anchor?.align ?? 'center'];

  return (
    <>
      <span
        ref={wrapperRef}
        className="contents"
        onPointerEnter={() => show('hover')}
        onPointerLeave={hideHover}
        onFocus={() => show('focus')}
        onBlur={() => setFocused(false)}
      >
        {cloneElement(children, { 'aria-describedby': describedBy })}
      </span>
      {createPortal(
        <div
          hidden={!open}
          onPointerEnter={clearTimer}
          onPointerLeave={hideHover}
          className={cx('fixed z-60', placement === 'top' ? 'pb-1.5' : 'pt-1.5')}
          style={{
            left: anchor?.x ?? 0,
            top: anchor?.y ?? 0,
            transform: `translate(${translateX}, ${placement === 'top' ? '-100%' : '0'})`,
          }}
        >
          <div
            role="tooltip"
            id={id}
            className="max-w-64 rounded bg-ink px-2 py-1 text-xs text-surface shadow-md"
          >
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
