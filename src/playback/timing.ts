// Injectable wall clock and frame scheduler, so the playback driver is deterministic in tests.
// manual.ts has the test doubles.

export interface Clock {
  /** Wall-clock milliseconds, monotonic. */
  now(): number;
}

export interface FrameScheduler {
  /** Runs the callback before the next repaint; returns a handle for cancel. */
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export const browserClock: Clock = {
  now: () => performance.now(),
};

/** requestAnimationFrame, or a ~60 Hz timer where it is missing (jsdom, background contexts). */
export function browserFrames(): FrameScheduler {
  if (typeof requestAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(() => cb()),
      cancel: (h) => cancelAnimationFrame(h),
    };
  }
  return {
    request: (cb) => setTimeout(cb, 16) as unknown as number,
    cancel: (h) => clearTimeout(h),
  };
}
