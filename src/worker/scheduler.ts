// How the engine host yields between work slices, so focus, fork, and reset messages are handled
// within one slice (P2 ≤ 1 s). Injectable: tests step a manual queue by hand.

/** Runs `task` later, after pending messages get a chance to run. */
export type Schedule = (task: () => void) => void;

interface Port {
  onmessage: ((e: unknown) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface MacrotaskScheduler {
  schedule: Schedule;
  /** Releases the channel (Node keeps a process alive while a port is open). */
  close(): void;
}

/**
 * A macrotask per call through a MessageChannel: unlike nested setTimeout(0), it is never clamped
 * to 4 ms, and incoming worker messages interleave with it. Falls back to setTimeout(0) where
 * MessageChannel is missing.
 */
export function macrotaskScheduler(): MacrotaskScheduler {
  if (typeof MessageChannel !== 'function') {
    return {
      schedule: (task) => {
        setTimeout(task, 0);
      },
      close: () => {},
    };
  }
  // Typed structurally: the worker's lib (WebWorker) and Node's types disagree about MessagePort.
  const channel = new MessageChannel() as unknown as { port1: Port; port2: Port };
  const tasks: (() => void)[] = [];
  channel.port1.onmessage = () => {
    const task = tasks.shift();
    if (task) task();
  };
  return {
    schedule: (task) => {
      tasks.push(task);
      channel.port2.postMessage(null);
    },
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}
