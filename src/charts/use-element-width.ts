// The width of an element in whole CSS pixels, kept current with a ResizeObserver. Null until
// measured, and where ResizeObserver or layout is unavailable (jsdom).

import { useCallback, useSyncExternalStore } from 'react';

export function useElementWidth(element: HTMLElement | null): number | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!element || typeof ResizeObserver !== 'function') return () => {};
      const observer = new ResizeObserver(onChange);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [element],
  );
  const getSnapshot = () => {
    const w = element ? Math.floor(element.getBoundingClientRect().width) : 0;
    return w > 0 ? w : null;
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
