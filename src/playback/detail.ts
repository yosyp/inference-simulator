// Detail on demand (02 §11, K7): which windows of per-request detail ('all' scope) the store has
// asked the worker for, so the canvas can draw dots at low speed. Windows are aligned slots so
// repeated requests dedupe.

import { DAY_MS, MINUTE_MS, type SimMs } from '../engine/time.ts';

/** Target width of one detail window; rounded to whole histogram buckets. */
export const DETAIL_WINDOW_MS = 10 * MINUTE_MS;

export interface DetailSlot {
  fromMs: SimMs;
  toMs: SimMs;
}

export function detailWindowMs(histBucketMs: number): number {
  return Math.max(histBucketMs, Math.round(DETAIL_WINDOW_MS / histBucketMs) * histBucketMs);
}

/** The aligned slot containing t, clipped to t's day. */
export function detailSlotAt(t: SimMs, windowMs: number): DetailSlot {
  const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
  const from = Math.max(dayStart, Math.floor(t / windowMs) * windowMs);
  return { fromMs: from, toMs: Math.min(dayStart + DAY_MS, from + windowMs) };
}

export interface DetailTracker {
  /** True when the slot was received, or requested and not yet answered. */
  has(slot: DetailSlot): boolean;
  /** Records a request for the slot; returns its requestTag. */
  begin(slot: DetailSlot): number;
  /** A reply arrived for the tag; `ok` marks the slot received, otherwise it may be asked again. */
  resolve(tag: number, ok: boolean): void;
  /** Forgets slots a fork invalidates, and every pending request (their replies will be stale). */
  cut(day: number, cutMs: SimMs, lasting: boolean): void;
  clear(): void;
}

export function createDetailTracker(): DetailTracker {
  const received = new Map<number, DetailSlot>();
  const pending = new Map<number, DetailSlot>();
  let nextTag = 1;
  return {
    has: (slot) =>
      received.has(slot.fromMs) || [...pending.values()].some((s) => s.fromMs === slot.fromMs),
    begin(slot) {
      const tag = nextTag++;
      pending.set(tag, slot);
      return tag;
    },
    resolve(tag, ok) {
      const slot = pending.get(tag);
      pending.delete(tag);
      if (slot && ok) received.set(slot.fromMs, slot);
    },
    cut(day, cutMs, lasting) {
      for (const [key, slot] of received) {
        const d = Math.floor(slot.fromMs / DAY_MS);
        if ((d === day && slot.toMs > cutMs) || (lasting && d > day)) received.delete(key);
      }
      pending.clear();
    },
    clear() {
      received.clear();
      pending.clear();
    },
  };
}
