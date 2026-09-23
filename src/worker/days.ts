// Streaming days: one chunk per step, silent replays up to what was already sent, checkpoints,
// and the fork cut rule on a day's slot (protocol.ts header; 04 §3; K21).

import type { CoreDayRun } from '../engine/core/index.ts';
import { dayRollup } from '../engine/index.ts';
import { chunkTransferables, type ResultChunk } from '../engine/results.ts';
import { dayStartMs, type DayIndex, type SimMs } from '../engine/time.ts';
import { covers, insertCheckpoint, thin, totalBytes } from './checkpoints.ts';
import { checkpointDue, checkpointInterval, nextChunkEnd, nextSilentEnd } from './grid.ts';
import {
  computedRanges,
  newDaySlot,
  openRunAt,
  rebind,
  type Active,
  type DaySlot,
} from './state.ts';

export function postChunk(h: Active, chunk: ResultChunk): void {
  const r = h.run;
  h.post({ type: 'chunk', runId: r.runId, revision: r.revision, chunk }, chunkTransferables(chunk));
}

export function postProgress(h: Active): void {
  const r = h.run;
  h.post({ type: 'progress', runId: r.runId, revision: r.revision, computed: computedRanges(r) });
}

/** Takes a checkpoint at run.nowMs if a step from fromMs reached this day's interval mark. */
export function maybeCheckpoint(h: Active, slot: DaySlot, run: CoreDayRun, fromMs: SimMs): void {
  const g = h.setup.grid;
  const focus = slot.day === h.run.focusDay;
  const interval = checkpointInterval(g, focus);
  if (!checkpointDue(g, slot.day, fromMs, run.nowMs, interval)) return;
  if (slot.checkpoints.some((s) => s.cp.atMs === run.nowMs)) return;
  if (!focus && firstVictim(h, slot)) return;
  slot.checkpoints = insertCheckpoint(slot.checkpoints, run.checkpoint());
  if (!focus) enforceBudget(h);
}

/** Byte order of eviction: farthest from the focus day first, later days first on ties. */
function evictionOrder(h: Active, a: DaySlot, b: DaySlot): number {
  const f = h.run.focusDay;
  return Math.abs(b.day - f) - Math.abs(a.day - f) || b.day - a.day;
}

/**
 * True when the budget is full and `slot` would lose a checkpoint first, so taking one (a clone
 * of several MB at Server B) would be wasted.
 */
function firstVictim(h: Active, slot: DaySlot): boolean {
  const others = h.run.days.filter((s) => s.day !== h.run.focusDay);
  const bytes = others.reduce((sum, s) => sum + totalBytes(s.checkpoints), 0);
  const size = others.flatMap((s) => s.checkpoints).at(-1)?.bytes ?? 0;
  if (bytes + size <= h.budgetBytes) return false;
  const holders = others.filter((s) => s.checkpoints.length > 0 || s === slot);
  return holders.sort((a, b) => evictionOrder(h, a, b))[0] === slot;
}

/**
 * Keeps non-focus checkpoints within the budget. The victim is the day farthest from the focus
 * day, later days first on ties (the day before the focus may still hold the playhead after a
 * lookahead focus), so the days next to it keep theirs longest.
 */
export function enforceBudget(h: Active): void {
  const r = h.run;
  const others = r.days.filter((s) => s.day !== r.focusDay);
  let bytes = others.reduce((sum, s) => sum + totalBytes(s.checkpoints), 0);
  while (bytes > h.budgetBytes) {
    const victim = others
      .filter((s) => s.checkpoints.length > 0)
      .sort((a, b) => evictionOrder(h, a, b))[0];
    if (!victim) return;
    // Drop the checkpoint whose removal leaves the shortest gap between its neighbours (the
    // morning and the shift's end bound the day), so the ones left stay spread out.
    const list = victim.checkpoints;
    const ds = dayStartMs(victim.day);
    const at = (i: number) =>
      i < 0
        ? ds + h.setup.grid.activeStartMs
        : i >= list.length
          ? ds + h.setup.grid.activeEndMs
          : list[i]!.cp.atMs;
    let drop = 0;
    for (let i = 1; i < list.length; i++) {
      if (at(i + 1) - at(i - 1) <= at(drop + 1) - at(drop - 1)) drop = i;
    }
    bytes -= list[drop]!.bytes;
    victim.checkpoints = list.filter((_, i) => i !== drop);
  }
}

function ensureRun(h: Active, slot: DaySlot): CoreDayRun {
  slot.run ??= openRunAt(h, slot.day, slot.streamedToMs);
  return slot.run;
}

/** One unit of a day's stream: a silent replay step, or one chunk posted with its progress. */
export function stepDay(h: Active, slot: DaySlot): void {
  const run = ensureRun(h, slot);
  const from = run.nowMs;
  const g = h.setup.grid;
  if (from < slot.streamedToMs) {
    run.advance(nextSilentEnd(g, slot.day, from, slot.streamedToMs));
    maybeCheckpoint(h, slot, run, from);
    return;
  }
  const end = nextChunkEnd(g, slot.day, from, { first: slot.first, targetMs: slot.targetMs });
  const chunk = run.advance(end);
  slot.first = false;
  if (slot.targetMs !== null && run.nowMs > slot.targetMs) slot.targetMs = null;
  slot.streamedToMs = run.nowMs;
  postChunk(h, chunk);
  postProgress(h);
  maybeCheckpoint(h, slot, run, from);
  if (run.done) {
    const r = h.run;
    h.post({
      type: 'dayComplete',
      runId: r.runId,
      revision: r.revision,
      day: slot.day,
      rollup: dayRollup(run.state),
    });
    slot.complete = true;
    slot.run = null;
  }
}

/** The first 15-minute mark after fromMs, up to limitMs, that no checkpoint serves; or null. */
function missingMark(h: Active, slot: DaySlot, fromMs: SimMs, limitMs: SimMs): SimMs | null {
  const g = h.setup.grid;
  const ds = dayStartMs(slot.day);
  const step = g.focusCheckpointMs;
  const first = Math.max(ds + g.activeStartMs, fromMs);
  for (let m = ds + (Math.floor((first - ds) / step) + 1) * step; m <= limitMs; m += step) {
    if (!covers(slot.checkpoints, m, g.chunkMs)) return m;
  }
  return null;
}

function densifyLimit(h: Active, slot: DaySlot): SimMs {
  return Math.min(slot.streamedToMs, dayStartMs(slot.day) + h.setup.grid.activeEndMs);
}

/** True while the focus day still lacks 15-minute checkpoints from the focus time on. */
export function needsDensify(h: Active, slot: DaySlot): boolean {
  if (!slot.densify) return false;
  const from = slot.densify.run?.nowMs ?? h.run.focusMs;
  if (missingMark(h, slot, from, densifyLimit(h, slot)) === null) {
    slot.densify = null;
    return false;
  }
  return true;
}

/** One silent step toward the next missing checkpoint on the focus day. */
export function stepDensify(h: Active, slot: DaySlot): void {
  const d = slot.densify!;
  const limit = densifyLimit(h, slot);
  d.run ??= openRunAt(h, slot.day, Math.min(h.run.focusMs, limit));
  const run = d.run;
  const from = run.nowMs;
  if (from >= limit) {
    slot.densify = null;
    return;
  }
  run.advance(nextSilentEnd(h.setup.grid, slot.day, from, limit));
  maybeCheckpoint(h, slot, run, from);
  if (run.nowMs >= limit) slot.densify = null;
}

/** The focus moved: thin the old focus day to the other-day policy, and densify the new one. */
export function refocus(h: Active, day: DayIndex, atMs: SimMs): void {
  const r = h.run;
  const g = h.setup.grid;
  if (day !== r.focusDay) {
    const old = r.days[r.focusDay]!;
    old.checkpoints = thin(old.checkpoints, old.day, g.otherCheckpointMs, g.chunkMs);
    old.densify = null;
    old.targetMs = null;
    r.focusDay = day;
    enforceBudget(h);
  }
  r.focusMs = atMs;
  // 'ready' waits for the frame the main thread is now waiting for.
  if (r.readyAfterMs !== null) r.readyAfterMs = atMs;
  const slot = r.days[day]!;
  if (slot.streamedToMs <= atMs && !slot.complete) slot.targetMs = atMs;
  slot.densify = slot.streamedToMs > dayStartMs(day) ? { run: null } : null;
}

/**
 * The fork cut rule on `slot`: data at or after cutMs is gone on the main thread, so the day
 * streams again from min(streamedToMs, cutMs) under the new patches. Checkpoints after the cut
 * are invalid; the live run survives only if it had not passed the cut.
 */
export function cutSlot(h: Active, slot: DaySlot, cutMs: SimMs): void {
  const cut = cutMs < slot.streamedToMs;
  slot.checkpoints = slot.checkpoints.filter((s) => s.cp.atMs <= cutMs);
  const to = Math.min(slot.streamedToMs, cutMs);
  slot.run = slot.run && slot.run.nowMs <= to ? rebind(h, slot.run) : null;
  if (slot.densify) slot.densify = { run: null };
  slot.streamedToMs = to;
  slot.complete = false;
  slot.first ||= cut;
}

/** A lasting fork recomputes a later day from its morning. */
export function resetSlot(h: Active, slot: DaySlot): DaySlot {
  const fresh = newDaySlot(slot.day);
  if (slot.day === h.run.focusDay) fresh.targetMs = h.run.focusMs;
  return fresh;
}
