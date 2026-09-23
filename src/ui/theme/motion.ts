// Motion tokens for UI chrome (modal, drawer, tabs). Under prefers-reduced-motion every chrome
// transition has zero duration (K18). The canvas is exempt: it follows the playhead, and that
// motion is the content (05 §10).

import type { Transition } from 'motion/react';
import { useSyncExternalStore } from 'react';

export const motionTokens = {
  /** Seconds, as Motion expects. */
  durationS: { fast: 0.12, base: 0.18, slow: 0.26 },
  /** Standard decelerate curve. */
  ease: [0.2, 0, 0, 1],
} as const;

export type MotionSpeed = keyof typeof motionTokens.durationS;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const mql = reducedMotionQuery();
  mql?.addEventListener('change', onChange);
  return () => mql?.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/** True when the user asks for reduced motion. Updates live if the setting changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** The transition for a chrome animation: instant under reduced motion. */
export function chromeTransition(reduced: boolean, speed: MotionSpeed = 'base'): Transition {
  return reduced
    ? { duration: 0 }
    : { duration: motionTokens.durationS[speed], ease: motionTokens.ease };
}

/** Hook form of chromeTransition. */
export function useChromeTransition(speed: MotionSpeed = 'base'): Transition {
  return chromeTransition(usePrefersReducedMotion(), speed);
}
