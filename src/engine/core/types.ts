// Types for the event core and day runner (00-build E2). README.md explains the plug-in API.

import type {
  DayCheckpoint,
  DayRun,
  DayRunInput,
  InjectedEvent,
  Patch,
  TunableParams,
} from '../api.ts';
import type { ResultChunk } from '../results.ts';
import type { DayIndex, SimMs } from '../time.ts';
import type { EventHandle, EventQueue, EventView } from './queue.ts';

/**
 * Everything a day run knows, as plain data: `core` plus one slice per module. Modules add their
 * slice by augmenting this interface from the file that declares it:
 *
 *   declare module '../core/types.ts' {
 *     interface DayState { replica: ReplicaSlice }
 *   }
 */
export interface DayState {
  core: CoreState;
}

/** Keys of module slices (every DayState key but `core`). */
export type SliceName = Exclude<keyof DayState, 'core'>;

export interface CoreState {
  day: DayIndex;
  dayStartMs: SimMs;
  /** dayStartMs + DAY_MS; exclusive. */
  dayEndMs: SimMs;
  /** Simulated time reached. Every event before it has run; none at or after it has. */
  nowMs: SimMs;
  /** Scalar buckets ending at or before this boundary are complete (onBucketEnd has run). */
  closedToMs: SimMs;
  /** Tunable parameters in effect now: config.tunable plus the 'set' patches applied so far. */
  params: TunableParams;
  queue: EventQueue;
  patches: PatchState;
  /** Canonical JSON of config and calibration; restore checks it. */
  inputKey: string;
}

export interface PatchState {
  /** 'set' patches dated before the day, applied into params before module init. */
  preDay: Patch[];
  /** Patches dated within [dayStartMs, dayEndMs), sorted by atMs, then input order. */
  inDay: Patch[];
  /** inDay[0 .. next) have been applied. */
  next: number;
}

/** What handlers and hooks get besides state. Owned by the run, never stored in state. */
export interface Ctx {
  /** Current simulated time. */
  readonly nowMs: SimMs;
  /** Config, calibration, day, detail, tracked analyst. A restore may change detail and tracking. */
  readonly input: DayRunInput;
  readonly dayStartMs: SimMs;
  readonly dayEndMs: SimMs;
  /**
   * Queues an event of `kind` at atMs >= nowMs with payload (a, b). Returns NO_EVENT, without
   * queueing, when atMs >= dayEndMs, since such an event can never fire in this day.
   */
  schedule(atMs: SimMs, kind: number, a?: number, b?: number): EventHandle;
  /** Cancels a pending event; a no-op for NO_EVENT or a handle that already fired. O(1). */
  cancel(handle: EventHandle): boolean;
  /** cancel(handle), then schedule(...). The usual way to move "my next event". */
  reschedule(handle: EventHandle, atMs: SimMs, kind: number, a?: number, b?: number): EventHandle;
  isPending(handle: EventHandle): boolean;
  /** Calls every subscriber of `topic` now, synchronously, in module order. */
  notify(topic: number, a?: number, b?: number): void;
}

/** A notice being delivered. Reused by the runner; subscribers must not keep it. */
export interface NoticeView {
  topic: number;
  a: number;
  b: number;
}

export type EventHandler = (state: DayState, ev: Readonly<EventView>, ctx: Ctx) => void;
export type NoticeHandler = (state: DayState, notice: Readonly<NoticeView>, ctx: Ctx) => void;

export interface EventSpec {
  /** Integer in the module's KIND_RANGES range. */
  readonly kind: number;
  /** For traces and errors, e.g. 'replica.stepEnd'. */
  readonly name: string;
  /** From PRIORITY; lower fires first at equal atMs. */
  readonly priority: number;
  readonly handle: EventHandler;
}

export interface NoticeSpec {
  readonly topic: number;
  readonly handle: NoticeHandler;
}

/** Scalar buckets completed during one advance: [bucketsFromMs, bucketsToMs), whole buckets. */
export interface ChunkSpan {
  fromMs: SimMs;
  toMs: SimMs;
  bucketsFromMs: SimMs;
  bucketsToMs: SimMs;
}

/** A plug-in. All members are optional except name and init. Hooks run in module-list order. */
export interface EngineModule<N extends SliceName = SliceName> {
  /** Slice key in DayState. */
  readonly name: N;
  /**
   * Builds this module's slice of the standard morning state (K21). Runs at dayStartMs after
   * pre-day 'set' patches are in state.core.params and earlier modules' slices exist. May schedule.
   */
  init(state: DayState, ctx: Ctx): DayState[N];
  /** Event kinds this module owns and handles. */
  readonly events?: readonly EventSpec[];
  /** Topics this module listens to. */
  readonly notices?: readonly NoticeSpec[];
  /** A 'set' patch took effect at ctx.nowMs; state.core.params already holds the new values. */
  onParams?(state: DayState, changes: Partial<TunableParams>, ctx: Ctx): void;
  /** An 'event' patch fired at ctx.nowMs. Every module sees every injected event. */
  onInjected?(state: DayState, event: InjectedEvent, ctx: Ctx): void;
  /**
   * Time reached a scalar bucket boundary: every event before boundaryMs has run, none at or after
   * it. ctx.nowMs === boundaryMs. Histogram boundaries are the ones divisible by histBucketMs.
   */
  onBucketEnd?(state: DayState, boundaryMs: SimMs, ctx: Ctx): void;
  /**
   * Builds the chunk returned by advance (E9). At most one module may define it; without one the
   * core returns an empty, contract-valid chunk. Must not change anything handlers read.
   */
  produceChunk?(state: DayState, span: ChunkSpan, ctx: Ctx): ResultChunk;
  /** Throws if this module's slice is inconsistent. Tests call it after every step. */
  assertInvariants?(state: DayState, ctx: Ctx): void;
}

/** Identity helper that type-checks a module against its augmented slice. */
export function defineModule<N extends SliceName>(module: EngineModule<N>): EngineModule<N> {
  return module;
}

export interface RunnerOptions {
  /** Called before each dispatch, including patches (kind PATCH_KIND, a = index in inDay). */
  trace?: (ev: Readonly<EventView>, state: DayState) => void;
  /** Check core and module invariants after every event. Slow; for tests. */
  assertEveryEvent?: boolean;
}

/** The DayRun contract plus test and tooling access. */
export interface CoreDayRun extends DayRun {
  /** Live state. Read it; don't mutate it from outside a handler. */
  readonly state: DayState;
  readonly dayEndMs: SimMs;
  /** Core and module invariants, plus a plain-data check of the whole state. */
  assertInvariants(): void;
}

/** What E11 wraps into the Engine (api.ts). */
export interface DayRunner {
  createDayRun(input: DayRunInput): CoreDayRun;
  /** Resume from a checkpoint; patches dated at or after checkpoint.atMs may differ. */
  restoreDayRun(input: DayRunInput, checkpoint: DayCheckpoint): CoreDayRun;
}
