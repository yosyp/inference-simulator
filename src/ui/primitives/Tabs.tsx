import { motion, useAnimate } from 'motion/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { chromeTransition, usePrefersReducedMotion } from '../theme/motion.ts';
import { cx, ends, step } from './util.ts';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Shown after the label, e.g. <Badge>Extrapolated</Badge>. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  /** DOM id base, shared with the matching <TabPanel tabsId>. */
  id: string;
  /** Accessible name of the tab list. */
  label: string;
  items: readonly TabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  /**
   * manual (default): arrow keys move focus; Enter or Space selects. Right for tabs whose switch is
   * expensive, like scenario tabs that reset the run. automatic: selection follows focus.
   */
  activation?: 'manual' | 'automatic';
  className?: string;
}

export function tabDomId(tabsId: string, itemId: string): string {
  return `${tabsId}-tab-${itemId}`;
}

export function tabPanelDomId(tabsId: string): string {
  return `${tabsId}-panel`;
}

/**
 * A WAI-ARIA tab list with a roving tabindex: one tab stop on the selected tab; Left and Right
 * (wrapping), Home, and End move between tabs. The selection underline slides between tabs.
 */
export function Tabs({
  id,
  label,
  items,
  selectedId,
  onSelect,
  activation = 'manual',
  className,
}: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduced = usePrefersReducedMotion();
  const disabled = (i: number) => items[i].disabled === true;
  const selectedIndex = items.findIndex((t) => t.id === selectedId);
  const tabStop =
    selectedIndex >= 0 && !disabled(selectedIndex)
      ? selectedIndex
      : ends(items.length, disabled)[0];

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const [first, last] = ends(items.length, disabled);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = step(i, 1, items.length, disabled);
    else if (e.key === 'ArrowLeft') next = step(i, -1, items.length, disabled);
    else if (e.key === 'Home') next = first;
    else if (e.key === 'End') next = last;
    if (next === null || next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    if (activation === 'automatic' && items[next].id !== selectedId) onSelect(items[next].id);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cx('flex min-w-0 items-stretch gap-0.5 overflow-x-auto', className)}
    >
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabDomId(id, item.id)}
            aria-selected={selected}
            aria-controls={tabPanelDomId(id)}
            disabled={item.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => {
              if (!selected) onSelect(item.id);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'relative inline-flex shrink-0 items-center gap-1.5 px-2.5 text-sm whitespace-nowrap',
              'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              'focus-visible:-outline-offset-2',
              selected ? 'font-semibold text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
            {item.badge}
            {selected && (
              <motion.span
                aria-hidden
                layoutId={`${id}-indicator`}
                transition={chromeTransition(reduced)}
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-ink"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** The id given to <Tabs>. */
  tabsId: string;
  selectedId: string;
  children: ReactNode;
  className?: string;
}

/**
 * The panel for the selected tab. Content stays mounted across tab changes; it fades in on each
 * change, except under reduced motion.
 */
export function TabPanel({ tabsId, selectedId, children, className }: TabPanelProps) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();
  const shown = useRef(selectedId);

  useEffect(() => {
    if (shown.current === selectedId) return;
    shown.current = selectedId;
    if (!reduced && scope.current) {
      void animate(scope.current, { opacity: [0.4, 1] }, chromeTransition(false, 'base'));
    }
  }, [selectedId, reduced, animate, scope]);

  return (
    <div
      ref={scope}
      role="tabpanel"
      id={tabPanelDomId(tabsId)}
      aria-labelledby={tabDomId(tabsId, selectedId)}
      className={className}
    >
      {children}
    </div>
  );
}
