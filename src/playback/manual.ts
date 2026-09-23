// Deterministic test doubles for the playback driver and the fake engine. Exported (not test-only)
// so the timeline, chrome, and canvas tests (U3, U5, U6) can drive a real store the same way.

import type { Clock, FrameScheduler } from './timing.ts';

export interface ManualClock extends Clock, FrameScheduler {
  /** Advances wall time by dtMs, then runs the frame callbacks requested before this call. */
  frame(dtMs?: number): void;
  /** Runs n frames of dtMs each. */
  frames(n: number, dtMs?: number): void;
  /** Advances wall time without running frames. */
  advance(dtMs: number): void;
  readonly pendingFrames: number;
}

export function createManualClock(startMs = 0): ManualClock {
  let now = startMs;
  let nextHandle = 1;
  let pending = new Map<number, () => void>();
  const clock: ManualClock = {
    now: () => now,
    request(cb) {
      const h = nextHandle++;
      pending.set(h, cb);
      return h;
    },
    cancel(h) {
      pending.delete(h);
    },
    advance(dtMs) {
      now += dtMs;
    },
    frame(dtMs = 16) {
      now += dtMs;
      const run = pending;
      pending = new Map();
      for (const cb of run.values()) cb();
    },
    frames(n, dtMs = 16) {
      for (let i = 0; i < n; i++) clock.frame(dtMs);
    },
    get pendingFrames() {
      return pending.size;
    },
  };
  return clock;
}

export interface TaskQueue {
  schedule(task: () => void): void;
  /** Runs one task; returns false when the queue was empty. */
  runNext(): boolean;
  /** Runs tasks, including ones they schedule, until empty or `limit` tasks have run. Returns the count. */
  runAll(limit?: number): number;
  /** Runs tasks until done() holds (checked before each task). Throws if the queue empties first. */
  runUntil(done: () => boolean, limit?: number): void;
  readonly size: number;
}

/** A FIFO stand-in for the event loop: pass `schedule` to createFakeTransport and step it by hand. */
export function createTaskQueue(): TaskQueue {
  const tasks: (() => void)[] = [];
  const queue: TaskQueue = {
    schedule: (task) => {
      tasks.push(task);
    },
    runNext() {
      const task = tasks.shift();
      if (!task) return false;
      task();
      return true;
    },
    runAll(limit = 100_000) {
      let n = 0;
      while (n < limit && queue.runNext()) n++;
      return n;
    },
    runUntil(done, limit = 100_000) {
      for (let n = 0; !done(); n++) {
        if (n >= limit || !queue.runNext()) throw new Error('runUntil: condition never held');
      }
    },
    get size() {
      return tasks.length;
    },
  };
  return queue;
}
