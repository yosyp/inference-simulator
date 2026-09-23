import { useSyncExternalStore } from 'react';

export interface ViewportSize {
  widthPx: number;
  heightPx: number;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

// A string snapshot is stable between renders when the size has not changed.
const snapshot = () => `${window.innerWidth}x${window.innerHeight}`;

/** The window's inner size in CSS px, updated on resize. */
export function useViewport(): ViewportSize {
  const [w, h] = useSyncExternalStore(subscribe, snapshot, () => '1440x900')
    .split('x')
    .map(Number);
  return { widthPx: w, heightPx: h };
}
