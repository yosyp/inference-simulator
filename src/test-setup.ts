import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Motion calls window.scrollTo when animating to height 'auto'; jsdom doesn't implement it.
window.scrollTo = () => {};

// Testing Library's async wrapper (which user-event runs through) drains with a setTimeout(0) that
// it advances only through Jest's fake-timer API. Point that API at Vitest's, so user-event works
// under vi.useFakeTimers(). It's only used when fake timers are on.
(globalThis as { jest?: { advanceTimersByTime: (ms: number) => void } }).jest = {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
};

afterEach(() => {
  cleanup();
});
