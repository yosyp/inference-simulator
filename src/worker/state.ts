// The engine host's state: one scenario setup per init, one run per init or reset, a slot per day.
// Plain functions over it live in days.ts (streaming, checkpoints), jobs.ts (detail and trace),
// and host.ts (messages and scheduling).

import type {
  AnalystId,
  DayCheckpoint,
  DayRunInput,
  Patch,
  SessionSummary,
} from '../engine/api.ts';
import type { Calibration } from '../engine/calibration.ts';
import type { CoreDayRun } from '../engine/core/index.ts';
import type { AssembledEngine } from '../engine/index.ts';
import type { ResultChunk, TransitionBlock } from '../engine/results.ts';
import { DAY_MS, WEEK_DAYS, dayStartMs, type DayIndex, type SimMs } from '../engine/time.ts';
import { latestAtOrBefore, type StoredCheckpoint } from './checkpoints.ts';
import type { Grid } from './grid.ts';
import type { ComputedRange, WorkerScenario, WorkerToMain } from './protocol.ts';

/** What init fixes until the next init: the scenario and everything derived from it alone. */
export interface Setup {
  scenario: WorkerScenario;
  calibration: Calibration;
  /** K28: 'all' for 1–2 replicas, else 'tracked'. */
  detail: 'all' | 'tracked';
  grid: Grid;
  /** sessionPlan per day under the baseline patches, for the next ready message; null until computed. */
  plans: (SessionSummary[] | null)[];
  /** The scenario rule's analyst. */
  initialTracked: AnalystId | null;
}

export interface DaySlot {
  day: DayIndex;
  /** Everything before this was posted under a revision no fork has invalidated. */
  streamedToMs: SimMs;
  /**
   * The live run, at or before streamedToMs (it replays silently up to it first). null: open one
   * lazily from the latest checkpoint at or before streamedToMs.
   */
  run: CoreDayRun | null;
  /** dayComplete was posted for the current data. */
  complete: boolean;
  checkpoints: StoredCheckpoint[];
  /** The next streamed chunk is the short one after a fork. */
  first: boolean;
  /** The chunk reaching this time ends at the next minute (init and focus). */
  targetMs: SimMs | null;
  /** Rebuilding 15-minute checkpoints after this day became the focus day (S1 §6). */
  densify: { run: CoreDayRun | null } | null;
}

export interface DetailJob {
  tag: number;
  day: DayIndex;
  fromMs: SimMs;
  toMs: SimMs;
  run: CoreDayRun | null;
  inFlight: TransitionBlock | null;
  parts: ResultChunk[];
}

export interface TraceJob {
  day: DayIndex;
  analyst: AnalystId;
  /** Main chunks from here on carry the analyst; the trace covers [day start, toMs). */
  toMs: SimMs;
  run: CoreDayRun | null;
  parts: ResultChunk[];
}

export interface HostRun {
  runId: number;
  revision: number;
  /** Baseline patches, then each fork's patch in arrival order (ties apply in array order). */
  patches: Patch[];
  tracked: AnalystId | null;
  focusDay: DayIndex;
  focusMs: SimMs;
  days: DaySlot[];
  details: DetailJob[];
  traces: TraceJob[];
  /** The last detail replay, reusable when the next window starts at or after it. */
  detailCache: {
    day: DayIndex;
    revision: number;
    tracked: AnalystId | null;
    run: CoreDayRun;
  } | null;
  /** 'ready' is owed once the focus day has streamed past this time (host.ts); null once sent. */
  readyAfterMs: SimMs | null;
  failed: boolean;
}

export interface Host {
  readonly engine: AssembledEngine;
  post(msg: WorkerToMain, transfer?: ArrayBuffer[]): void;
  /** Byte budget for checkpoints of days other than the focus day. */
  readonly budgetBytes: number;
  setup: Setup | null;
  run: HostRun | null;
}

/** A host with an active run: what every step function takes. */
export interface Active extends Host {
  setup: Setup;
  run: HostRun;
}

export function newDaySlot(day: DayIndex): DaySlot {
  return {
    day,
    streamedToMs: dayStartMs(day),
    run: null,
    complete: false,
    checkpoints: [],
    first: false,
    targetMs: null,
    densify: null,
  };
}

export function newRun(runId: number, setup: Setup, focusDay: DayIndex, focusMs: SimMs): HostRun {
  const days = Array.from({ length: WEEK_DAYS }, (_, d) => newDaySlot(d as DayIndex));
  days[focusDay]!.targetMs = focusMs;
  return {
    runId,
    revision: 0,
    patches: [...setup.scenario.baselinePatches],
    tracked: setup.initialTracked,
    focusDay,
    focusMs,
    days,
    details: [],
    traces: [],
    detailCache: null,
    readyAfterMs: focusMs,
    failed: false,
  };
}

export function inputFor(
  h: Active,
  day: DayIndex,
  over: Partial<Pick<DayRunInput, 'detail' | 'trackedAnalyst'>> = {},
): DayRunInput {
  return {
    config: h.setup.scenario.config,
    calibration: h.setup.calibration,
    day,
    patches: h.run.patches,
    trackedAnalyst: over.trackedAnalyst !== undefined ? over.trackedAnalyst : h.run.tracked,
    detail: over.detail ?? h.setup.detail,
  };
}

/** A run of `day` from its latest checkpoint at or before atMs, or from its morning. */
export function openRunAt(
  h: Active,
  day: DayIndex,
  atMs: SimMs,
  over: Partial<Pick<DayRunInput, 'detail' | 'trackedAnalyst'>> = {},
  extra: DayCheckpoint | null = null,
): CoreDayRun {
  let cp = latestAtOrBefore(h.run.days[day]!.checkpoints, atMs);
  if (extra && extra.atMs <= atMs && (!cp || extra.atMs > cp.atMs)) cp = extra;
  const input = inputFor(h, day, over);
  return cp ? h.engine.restoreDayRun(input, cp) : h.engine.createDayRun(input);
}

/** The same run under the current patches and tracked analyst (a fork or track changed them). */
export function rebind(
  h: Active,
  run: CoreDayRun,
  over: Parameters<typeof inputFor>[2] = {},
): CoreDayRun {
  return h.engine.restoreDayRun(inputFor(h, run.day, over), run.checkpoint());
}

/** Every day's [start, streamedToMs), merged where days meet. */
export function computedRanges(r: HostRun): ComputedRange[] {
  const out: ComputedRange[] = [];
  for (const slot of r.days) {
    const from = dayStartMs(slot.day);
    if (slot.streamedToMs <= from) continue;
    const last = out[out.length - 1];
    if (last && last.toMs === from) last.toMs = slot.streamedToMs;
    else out.push({ fromMs: from, toMs: slot.streamedToMs });
  }
  return out;
}

/** The focus day, then later days, then earlier ones: playback moves forward. */
export function dayOrder(focus: DayIndex): DayIndex[] {
  const out: DayIndex[] = [];
  for (let d = focus; d < WEEK_DAYS; d++) out.push(d as DayIndex);
  for (let d = 0; d < focus; d++) out.push(d as DayIndex);
  return out;
}

export function dayEndMs(day: DayIndex): SimMs {
  return dayStartMs(day) + DAY_MS;
}
