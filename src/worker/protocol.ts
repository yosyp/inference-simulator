// Main thread ⇄ engine worker messages (04-stack §3, K11, K21). Frozen at M0: change only through the integrator.
//
// Runs and revisions: `init` and `reset` start a new runId; the main thread drops every message
// from an older runId. Each `fork` carries a new, larger revision chosen by the main thread, and
// every later worker message carries the revision it was computed under. An older-revision
// message is dropped only where a newer fork invalidates it: data on the fork's day at or after
// its cutMs, or on a later day if the patch is lasting. Everything else in it is still valid and
// is kept, because the worker never resends it. Older-revision `progress` messages are always
// dropped.
//
// Ordering: the worker posts messages in order, and posts each chunk before the `progress`
// message that covers it. `progress.computed` is the full list of computed ranges, not a delta.
// The worker sends `ready` after both `init` and `reset`, and one `detail` reply per requestTag.
// A `fork` also moves the worker's focus to the fork's day.
//
// Fork cut rule. A fork at atMs cuts at cutMs = floor(atMs / histBucketMs) × histBucketMs. On the
// fork's day, the main thread discards buckets starting at or after cutMs, requests whose endMs is
// at or after cutMs, transitions and replica events at or after cutMs. If the patch is lasting
// ('set'), it also discards every later day. The worker restores a checkpoint at or before cutMs,
// replays silently to cutMs, and streams from cutMs under the new revision. The patch itself
// applies at atMs; the charts mark the fork at atMs.

import type { AnalystId, Patch, SimConfig } from '../engine/api.ts';
import type { Calibration } from '../engine/calibration.ts';
import type { ResultChunk, RollupRow } from '../engine/results.ts';
import type { DayIndex, SimMs } from '../engine/time.ts';

export type TrackedAnalystRule =
  | { rule: 'fixed'; analyst: AnalystId }
  /** The analyst with a session spanning the lesson moment, with at least minTurnsAfter turns after it; ties broken by the seed. */
  | { rule: 'spansMoment'; momentMs: SimMs; minTurnsAfter: number };

/** The part of a Scenario the worker needs. Plain data only. */
export interface WorkerScenario {
  config: SimConfig;
  /** The baseline week's patches, including the scheduled lesson moment (K1). */
  baselinePatches: Patch[];
  tracked: TrackedAnalystRule;
}

export interface ComputedRange {
  fromMs: SimMs;
  toMs: SimMs;
}

export type MainToWorker =
  | {
      type: 'init';
      runId: number;
      scenario: WorkerScenario;
      calibration: Calibration;
      /** Compute this time's day first, then the rest of the week (K21). */
      focusMs: SimMs;
    }
  /** The playhead moved; compute its day next and stay ahead of it. */
  | { type: 'focus'; runId: number; atMs: SimMs }
  | { type: 'fork'; runId: number; revision: number; patch: Patch }
  | { type: 'reset'; runId: number; focusMs: SimMs }
  /**
   * Re-simulate [fromMs, toMs) with detail 'all' for canvas dots (02 §11, K7). Answered with one
   * 'detail' per requestTag. The detail chunk must place every request already in flight at fromMs:
   * a synthetic transition at fromMs with its current state and replica (or its earlier transitions,
   * plus records for any that end in the window). Otherwise long-running requests vanish as dots at
   * the start of each window.
   */
  | { type: 'requestDetail'; runId: number; requestTag: number; fromMs: SimMs; toMs: SimMs }
  /** Change the tracked analyst; the worker answers with 'trace' chunks for the computed days. */
  | { type: 'track'; runId: number; analyst: AnalystId | null };

export type WorkerToMain =
  /** Sent right after init and after reset, before any chunk. */
  | { type: 'ready'; runId: number; trackedAnalyst: AnalystId | null }
  | { type: 'chunk'; runId: number; revision: number; chunk: ResultChunk }
  | { type: 'dayComplete'; runId: number; revision: number; day: DayIndex; rollup: RollupRow[] }
  | { type: 'progress'; runId: number; revision: number; computed: ComputedRange[] }
  | { type: 'detail'; runId: number; revision: number; requestTag: number; chunk: ResultChunk }
  | {
      type: 'trace';
      runId: number;
      revision: number;
      analyst: AnalystId;
      day: DayIndex;
      chunk: ResultChunk;
    }
  | { type: 'error'; runId: number; message: string };
