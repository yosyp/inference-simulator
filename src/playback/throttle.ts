// Leading- and trailing-edge throttle for store notifications (usePlaybackSelector).

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const hostTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Throttled {
  call(): void;
  cancel(): void;
}

/**
 * Runs fn at most once per intervalMs. A call inside the interval schedules one trailing run at
 * the interval's end, so the last change is never lost.
 */
export function throttle(fn: () => void, intervalMs: number, timers = hostTimers): Throttled {
  let last = -Infinity;
  let pending: unknown = null;
  const fire = () => {
    pending = null;
    last = timers.now();
    fn();
  };
  return {
    call() {
      if (pending !== null) return;
      const wait = last + intervalMs - timers.now();
      if (wait <= 0) fire();
      else pending = timers.setTimeout(fire, wait);
    },
    cancel() {
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
    },
  };
}
