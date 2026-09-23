// Deferred notices. The scheduler changes its own state first and notifies afterwards, in the
// order the changes happened, so a subscriber never sees a half-composed step. Scratch, not state:
// the buffer is empty between top-level calls. Each entry point flushes only what it pushed, so a
// subscriber that calls back into the replica (a re-entrant dispatch or cancel) stays correct.

import type { Ctx } from '../core/index.ts';

const buf: number[] = [];

/** Where the current entry point's notices start. */
export function noticeMark(): number {
  return buf.length;
}

export function pushNotice(topic: number, a: number, b: number): void {
  buf.push(topic, a, b);
}

/** Emits the notices pushed since `mark`, in order, then drops them. */
export function flushNotices(ctx: Ctx, mark: number): void {
  // Read the end each time: a re-entrant call may push (and flush) its own notices meanwhile.
  for (let i = mark; i < buf.length; i += 3) ctx.notify(buf[i]!, buf[i + 1]!, buf[i + 2]!);
  buf.length = mark;
}

/** Drops pending notices after a handler threw, so later runs start clean. */
export function resetNotices(): void {
  buf.length = 0;
}
