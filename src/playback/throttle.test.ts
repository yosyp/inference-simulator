import { describe, expect, it, vi } from 'vitest';
import { throttle, type Timers } from './throttle.ts';

function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const h = next++;
      pending.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h) => pending.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [h, t] of [...pending]) {
      if (t.at <= now) {
        pending.delete(h);
        t.fn();
      }
    }
  };
  return { timers, advance, pending };
}

describe('throttle', () => {
  it('fires at once, then at most once per interval with a trailing call', () => {
    const { timers, advance } = manualTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100, timers);
    t.call();
    expect(fn).toHaveBeenCalledTimes(1);
    t.call();
    t.call();
    expect(fn).toHaveBeenCalledTimes(1);
    advance(99);
    expect(fn).toHaveBeenCalledTimes(1);
    advance(1);
    expect(fn).toHaveBeenCalledTimes(2); // trailing
    advance(500);
    t.call();
    expect(fn).toHaveBeenCalledTimes(3); // idle long enough: leading again
  });

  it('limits a stream of calls to the rate', () => {
    const { timers, advance } = manualTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100, timers);
    for (let i = 0; i < 60; i++) {
      t.call();
      advance(16);
    }
    expect(fn.mock.calls.length).toBeLessThanOrEqual(11);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it('cancels a pending trailing call', () => {
    const { timers, advance, pending } = manualTimers();
    const fn = vi.fn();
    const t = throttle(fn, 100, timers);
    t.call();
    t.call();
    t.cancel();
    expect(pending.size).toBe(0);
    advance(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
