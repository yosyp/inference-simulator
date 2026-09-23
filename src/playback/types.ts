// Playback and view-model contracts (docs/00-build.md §4). Frozen at M0: change only through the integrator.
//
// Layering: the engine client (U2) turns worker chunks into a ResultsIndex. Renderers take plain
// view data: the canvas (U3) draws a SceneState; charts (U4) build panels from ResultsIndex queries.
// src/fixtures provides a fake ResultsIndex so renderers can be built before the engine exists.

import type { AnalystId, Patch, ReplicaId } from '../engine/api.ts';
import type { HistogramMetric } from '../engine/histogram.ts';
import type { ReplicaState, ResultChunk, RollupRow, ScalarMetric } from '../engine/results.ts';
import type { DayIndex, SimMs } from '../engine/time.ts';
import type { ComputedRange } from '../worker/protocol.ts';
import type { Scenario } from '../scenarios/schema.ts';

export type Mode = 'live' | 'highSide';

export interface ForkMarker {
  atMs: SimMs;
  revision: number;
  label: string;
}

export interface PlaybackState {
  scenarioId: string | null;
  runId: number;
  revision: number;
  playheadMs: SimMs;
  playing: boolean;
  /** 1 to 1000 (05 §5). */
  speed: number;
  mode: Mode;
  /** True while the playhead waits for uncomputed time. */
  buffering: boolean;
  computed: readonly ComputedRange[];
  forks: readonly ForkMarker[];
  trackedAnalyst: AnalystId | null;
}

/** useSyncExternalStore-compatible. The canvas subscribes outside React; components use throttled selectors. */
export interface PlaybackStore {
  getState(): PlaybackState;
  subscribe(listener: () => void): () => void;
  readonly index: ResultsIndex;
  /** The loaded scenario (shift, lesson moment, entry, copy), or null before loadScenario. */
  readonly scenario: Scenario | null;
  loadScenario(scenario: Scenario): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  seek(atMs: SimMs): void;
  setMode(mode: Mode): void;
  /** Fork at the playhead with this patch (its atMs is overwritten with the playhead). */
  fork(patch: Patch, label: string): void;
  reset(): void;
  jumpToEntry(): void;
  track(analyst: AnalystId | null): void;
  dispose(): void;
}

export interface TimeWindow {
  fromMs: SimMs;
  toMs: SimMs;
}

/** Points cover [t[i], t[i] + stepMs). NaN values mark gaps (uncomputed or empty). */
export interface SeriesData {
  t: Float64Array;
  stepMs: number;
  v: Float64Array;
}

export interface QuantileData {
  t: Float64Array;
  stepMs: number;
  /** One array per requested quantile, in request order. */
  values: Float64Array[];
  counts: Float64Array;
}

/** Individual requests for sparse buckets (05 §6), keyed by first-token or end time. */
export interface RequestPoints {
  t: Float64Array;
  ttftMs: Float64Array;
  tpotMs: Float64Array;
  e2eMs: Float64Array;
  replica: Int8Array;
  analyst: Uint32Array;
}

export interface ReplicaSnapshot {
  replica: ReplicaId;
  state: ReplicaState;
  /** 0..1 progress through the current loading phase; null when not loading. */
  phaseProgress: number | null;
  kvUsedFrac: number;
  running: number;
  waiting: number;
  preemptionsPerMin: number;
  prefillTokensPerS: number;
  decodeTokensPerS: number;
  nvidiaSmiUtil: number;
  computeUtil: number;
}

/** What the live status line and aggregate canvas mode read (05 §8). */
export interface StatusSnapshot {
  atMs: SimMs;
  replicas: ReplicaSnapshot[];
  fleet: {
    offeredPerS: number;
    admittedPerS: number;
    rejectedPerS: number;
    amplification: number;
    ttftP99Ms: number;
    abandonedSessions: number;
  };
}

export type DotState = 'queued' | 'prefill' | 'decode' | 'preempted';

export interface DotView {
  /** Stable across frames: day-local request id. */
  request: number;
  analyst: AnalystId;
  state: DotState;
  /** 0..1 progress through the current phase, for animation. */
  progress: number;
  tracked: boolean;
}

export interface ReplicaView extends ReplicaSnapshot {
  dots: DotView[];
}

export interface TrackedRequestView {
  request: number;
  turn: number;
  replica: ReplicaId | null;
  state: DotState | 'finished' | 'rejected' | 'timedOut' | 'failed';
  ttftMs: number | null;
  /** True when this turn landed on a different replica than the previous turn. */
  moved: boolean;
}

/** Canvas input at one instant (05 §7). A pure function of simulated time. */
export interface SceneState {
  atMs: SimMs;
  mode: Mode;
  /** 'aggregate' above the speed threshold or when request detail is unavailable. */
  detail: 'dots' | 'aggregate';
  router: { atRouter: DotView[]; offeredPerS: number };
  replicas: ReplicaView[];
  tracked: { analyst: AnalystId; requests: TrackedRequestView[] } | null;
}

export interface ResultsIndex {
  /** Increments whenever data changes; use it to memoize. */
  readonly version: number;
  readonly replicas: number;
  computed(): readonly ComputedRange[];
  scalarSeries(
    metric: ScalarMetric,
    series: number,
    window: TimeWindow,
    columns: number,
  ): SeriesData;
  quantileSeries(
    metric: HistogramMetric,
    series: number,
    window: TimeWindow,
    columns: number,
    quantiles: readonly number[],
  ): QuantileData;
  /** Requests finishing in the window; empty when per-request records are unavailable there. */
  requestPoints(window: TimeWindow): RequestPoints;
  sceneAt(
    atMs: SimMs,
    opts: { mode: Mode; detail: 'dots' | 'aggregate'; trackedAnalyst: AnalystId | null },
  ): SceneState;
  statusAt(atMs: SimMs): StatusSnapshot;
  /** Rollup rows for every completed day; the High-side view filters by deliveredAtMs (U7). */
  rollup(): readonly RollupRow[];
  /** Days whose computation has finished. */
  completedDays(): readonly DayIndex[];
}

/**
 * The write side of the results index (U8), driven by the engine client (U2) from worker messages.
 * Created with createResultsStore(replicas) in src/playback/index/.
 */
export interface ResultsStore {
  readonly index: ResultsIndex;
  reset(replicas: number): void;
  addChunk(chunk: ResultChunk): void;
  /** Detail-scope ('all') requests and transitions for a window, from a requestDetail reply. */
  addDetail(chunk: ResultChunk): void;
  /** Replaces the tracked analyst's records for a day, from a trace reply. */
  addTrace(day: DayIndex, chunk: ResultChunk): void;
  addRollup(day: DayIndex, rows: readonly RollupRow[]): void;
  setComputed(ranges: readonly ComputedRange[]): void;
  /** Applies the fork cut rule (src/worker/protocol.ts) for a fork on `day` cutting at cutMs. */
  cut(day: DayIndex, cutMs: SimMs, lasting: boolean): void;
}
