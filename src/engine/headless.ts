// Headless runs (00-build E11): simulate one day or several in Node, without the worker. C1's
// scenario CLI, the lesson assertions, and pnpm perf use this.
//
//   const r = runHeadless({ config, calibration, patches, days: 2, tracked: scenario.tracked });
//   r.days[0].chunks   // ResultChunks in time order, chunkMs apart
//   r.days[0].rollup   // the High-side rows, once the day ran to its end
//
// Days are independent (K21), so each starts from its own morning. The engine may not read a wall
// clock, so pass `now` (e.g. performance.now) to get timing stats; without it they read 0.

import type { AnalystId, DayRunInput, Patch, SimConfig } from './api.ts';
import type { Calibration } from './calibration.ts';
import type { CoreDayRun } from './core/index.ts';
import {
  dayRollup,
  detailFor,
  engine as defaultEngine,
  pickTrackedAnalyst,
  type AssembledEngine,
  type TrackedRule,
} from './index.ts';
import type { ResultChunk, RollupRow } from './results.ts';
import {
  DAY_MS,
  MINUTE_MS,
  WEEK_DAYS,
  dayStartMs,
  isDayIndex,
  type DayIndex,
  type SimMs,
} from './time.ts';

export const HEADLESS_CHUNK_MS = 5 * MINUTE_MS;

export interface HeadlessInput {
  config: SimConfig;
  calibration: Calibration;
  /** Every patch in effect for the week (api.ts DayRunInput.patches). Default none. */
  patches?: readonly Patch[];
  /** One day, or days to run in this order. Default: the whole week. */
  days?: DayIndex | readonly DayIndex[];
  /** Default: detailFor(config) (K28). */
  detail?: 'all' | 'tracked';
  /** An analyst, a scenario's rule (picked as the worker does), or null. Default null. */
  tracked?: AnalystId | null | TrackedRule;
  /** Simulated time per chunk; a positive multiple of config.histBucketMs. Default 5 minutes. */
  chunkMs?: number;
  /** Stop each day at this time of day (ms after its midnight) instead of its end. */
  untilTimeOfDayMs?: number;
  /** Keep chunks in the result. Default true; onChunk sees them either way. */
  keepChunks?: boolean;
  onChunk?: (chunk: ResultChunk, wallMs: number) => void;
  /** Wall clock in ms, for the timing stats. */
  now?: () => number;
  /** Default: the assembled engine. Tests pass createEngine({ assertEveryEvent: true }). */
  engine?: AssembledEngine;
}

export interface HeadlessDay {
  day: DayIndex;
  input: DayRunInput;
  /** The finished run: its live state is there for lesson helpers to read. */
  run: CoreDayRun;
  chunks: ResultChunk[];
  /** Wall ms per chunk, in chunk order (kept even when chunks are not). */
  chunkWallMs: number[];
  /** Null when the day stopped before its end. */
  rollup: RollupRow[] | null;
  simMs: number;
  wallMs: number;
}

export interface HeadlessResult {
  trackedAnalyst: AnalystId | null;
  days: HeadlessDay[];
  simMs: number;
  wallMs: number;
  /** Simulated seconds per wall second over every day run; NaN without a clock. */
  speed: number;
}

function daysOf(days: HeadlessInput['days']): DayIndex[] {
  if (days === undefined) return Array.from({ length: WEEK_DAYS }, (_, d) => d as DayIndex);
  const list = typeof days === 'number' ? [days] : [...days];
  for (const d of list) if (!isDayIndex(d)) throw new RangeError(`Day ${d} is not a work-week day`);
  return list;
}

function resolveTracked(input: HeadlessInput): AnalystId | null {
  const t = input.tracked ?? null;
  if (t === null || typeof t === 'number') return t;
  return pickTrackedAnalyst(t, {
    config: input.config,
    calibration: input.calibration,
    patches: input.patches ?? [],
    trackedAnalyst: null,
    detail: 'tracked',
  });
}

/** Runs one day from its morning to `untilMs` (clamped to the day), chunkMs at a time. */
export function runHeadlessDay(
  input: HeadlessInput,
  day: DayIndex,
  trackedAnalyst: AnalystId | null,
): HeadlessDay {
  const eng = input.engine ?? defaultEngine;
  const now = input.now ?? (() => 0);
  const chunkMs = input.chunkMs ?? HEADLESS_CHUNK_MS;
  const hb = input.config.histBucketMs;
  if (!(chunkMs > 0 && chunkMs % hb === 0)) {
    throw new RangeError(`chunkMs ${chunkMs} must be a positive multiple of histBucketMs ${hb}`);
  }
  const dayInput: DayRunInput = {
    config: input.config,
    calibration: input.calibration,
    day,
    patches: input.patches ?? [],
    trackedAnalyst,
    detail: input.detail ?? detailFor(input.config),
  };
  const start = dayStartMs(day);
  const until: SimMs = start + Math.min(DAY_MS, input.untilTimeOfDayMs ?? DAY_MS);
  const keep = input.keepChunks ?? true;
  const chunks: ResultChunk[] = [];
  const chunkWallMs: number[] = [];
  const t0 = now();
  const run = eng.createDayRun(dayInput);
  while (run.nowMs < until) {
    const next = Math.min(until, start + (Math.floor((run.nowMs - start) / chunkMs) + 1) * chunkMs);
    const c0 = now();
    const chunk = run.advance(next);
    const wall = now() - c0;
    chunkWallMs.push(wall);
    if (keep) chunks.push(chunk);
    input.onChunk?.(chunk, wall);
  }
  return {
    day,
    input: dayInput,
    run,
    chunks,
    chunkWallMs,
    rollup: run.done ? dayRollup(run.state) : null,
    simMs: run.nowMs - start,
    wallMs: now() - t0,
  };
}

/** Runs the requested days in order, each from its morning (K21). */
export function runHeadless(input: HeadlessInput): HeadlessResult {
  const now = input.now;
  const trackedAnalyst = resolveTracked(input);
  const days = daysOf(input.days).map((d) => runHeadlessDay(input, d, trackedAnalyst));
  const simMs = days.reduce((s, d) => s + d.simMs, 0);
  const wallMs = days.reduce((s, d) => s + d.wallMs, 0);
  return {
    trackedAnalyst,
    days,
    simMs,
    wallMs,
    speed: now && wallMs > 0 ? simMs / wallMs : NaN,
  };
}
