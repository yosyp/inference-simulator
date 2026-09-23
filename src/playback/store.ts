// The playback store and engine client (00-build U2; 04 §3; 05 §4–§5; K11, K16, K21).
//
// It owns the playhead and a requestAnimationFrame driver, speaks the worker protocol through an
// EngineTransport, and routes worker results into a ResultsStore (U8). State is immutable per change
// and useSyncExternalStore-compatible. The playhead changes every frame, so React components read it
// through usePlaybackSelector (throttled) and the canvas through subscribeFrame (every frame).

import { calibration as defaultCalibration } from '../data/calibration.ts';
import { isLasting, type Patch } from '../engine/api.ts';
import type { Calibration } from '../engine/calibration.ts';
import type { ResultChunk } from '../engine/results.ts';
import { MINUTE_MS, WEEK_MS, dayOf, type DayIndex, type SimMs } from '../engine/time.ts';
import { toWorkerScenario, type Scenario } from '../scenarios/schema.ts';
import type { ComputedRange, MainToWorker, WorkerToMain } from '../worker/protocol.ts';
import { createDetailTracker, detailSlotAt, detailWindowMs, type DetailSlot } from './detail.ts';
import {
  applyCutToRanges,
  classifyOlderChunk,
  cutMsFor,
  dayInvalidated,
  type CutRecord,
} from './forks.ts';
import { coversRange, normalizeRanges, sameRanges } from './ranges.ts';
import { advancePlayhead, bufferingAt, inShift, playableAt } from './shift.ts';
import { browserClock, browserFrames, type Clock, type FrameScheduler } from './timing.ts';
import type { EngineTransport } from './transport.ts';
import type { PlaybackState, PlaybackStore, ResultsIndex, ResultsStore } from './types.ts';

export const MIN_SPEED = 1;
export const MAX_SPEED = 1000;
/** Dots are legible up to about 10× (05 §5, open item 4); above it the canvas shows aggregate flow. */
export const DOTS_MAX_SPEED = 10;
/** Longest wall-clock step one frame may advance, so a tab returning from the background doesn't leap. */
export const MAX_FRAME_WALL_MS = 250;
/** Ask the worker for the next needed day this far (in wall time at the current speed) ahead of the playhead. */
export const FOCUS_LOOKAHEAD_WALL_MS = 10_000;
/** ...and never less than this much simulated time ahead. */
export const FOCUS_LOOKAHEAD_MIN_SIM_MS = 30 * MINUTE_MS;

export function clampSpeed(speed: number): number {
  if (Number.isNaN(speed)) return MIN_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** The canvas detail level for a speed (05 §5). */
export function detailModeFor(speed: number, dotsMaxSpeed = DOTS_MAX_SPEED): 'dots' | 'aggregate' {
  return speed <= dotsMaxSpeed ? 'dots' : 'aggregate';
}

export type FrameListener = (state: PlaybackState, index: ResultsIndex) => void;

/** Key of the store's frame-loop hook; use subscribeFrame (frame.ts) rather than calling it. */
export const FRAME_SOURCE: unique symbol = Symbol('playback.frameSource');

export interface PlaybackStoreOptions {
  transport: EngineTransport;
  /** Builds the results store: U8's createResultsStore, or createFixtureResultsStore until it lands. */
  createResults: (replicas: number) => ResultsStore;
  /** Default: src/data/calibration.ts. */
  calibration?: Calibration;
  clock?: Clock;
  frames?: FrameScheduler;
  /** Engine errors. Default: console.error. */
  onError?: (message: string) => void;
  dotsMaxSpeed?: number;
}

export interface EngineClientStore extends PlaybackStore {
  /** The loaded scenario (shift, lesson moment, entry point), or null before loadScenario. */
  readonly scenario: Scenario | null;
  [FRAME_SOURCE](listener: FrameListener): () => void;
}

const INITIAL_STATE: PlaybackState = Object.freeze({
  scenarioId: null,
  runId: 0,
  revision: 0,
  playheadMs: 0,
  playing: false,
  speed: 1,
  mode: 'live',
  buffering: false,
  computed: [],
  forks: [],
  trackedAnalyst: null,
});

export function createPlaybackStore(options: PlaybackStoreOptions): EngineClientStore {
  const { transport } = options;
  const calibration = options.calibration ?? defaultCalibration;
  const clock = options.clock ?? browserClock;
  const frames = options.frames ?? browserFrames();
  const onError = options.onError ?? ((message: string) => console.error(message));
  const dotsMaxSpeed = options.dotsMaxSpeed ?? DOTS_MAX_SPEED;
  const results = options.createResults(1);

  const listeners = new Set<() => void>();
  const frameListeners = new Set<FrameListener>();
  const detail = createDetailTracker();
  let scenario: Scenario | null = null;
  let state = INITIAL_STATE;
  let runCounter = 0;
  /** Cuts of this run's forks, for judging older-revision messages (forks.ts). */
  let cuts: CutRecord[] = [];
  /**
   * The worker's focus day: the playhead's day, which keeps 15-minute checkpoints for forks (P2).
   * The prefetch day is the next day a lookahead asked the worker to stream first (protocol.ts).
   */
  let focusDay: DayIndex | null = null;
  let prefetchDay: DayIndex | null = null;
  let userTracked = false;
  let lastNow = 0;
  let frameHandle: number | null = null;
  let frameDirty = false;
  let disposed = false;

  function notify() {
    for (const l of [...listeners]) l();
    if (frameListeners.size > 0) {
      frameDirty = true;
      scheduleFrame();
    }
  }

  function setState(patch: Partial<PlaybackState>) {
    state = Object.freeze({ ...state, ...patch });
    notify();
  }

  function post(msg: MainToWorker) {
    if (!disposed) transport.postMessage(msg);
  }

  // --- Frame loop -------------------------------------------------------------------------------

  function scheduleFrame() {
    if (frameHandle === null && !disposed) frameHandle = frames.request(onFrame);
  }

  function onFrame() {
    frameHandle = null;
    if (disposed) return;
    if (state.playing) tick();
    if (frameListeners.size > 0 && (frameDirty || state.playing)) {
      frameDirty = false;
      const s = state;
      for (const l of [...frameListeners]) l(s, results.index);
    }
    if (state.playing) scheduleFrame();
  }

  function tick() {
    const s = scenario!;
    const now = clock.now();
    const wallMs = Math.min(MAX_FRAME_WALL_MS, Math.max(0, now - lastNow));
    lastNow = now;
    const r = advancePlayhead(state.playheadMs, wallMs * state.speed, s.sim.shift, state.computed);
    if (r.playheadMs !== state.playheadMs || r.buffering !== state.buffering || r.ended) {
      setState({ playheadMs: r.playheadMs, buffering: r.buffering, playing: !r.ended });
    }
    afterMove();
  }

  // --- Focus and detail requests ----------------------------------------------------------------

  function afterMove() {
    maybeFocus();
    maybeRequestDetail();
  }

  function sendFocus(atMs: SimMs) {
    focusDay = dayOf(atMs);
    prefetchDay = null;
    post({ type: 'focus', runId: state.runId, atMs });
  }

  /**
   * Focus when the playhead enters another day. Prefetch when playback nears uncomputed time on
   * a later day: that day streams next, and the playhead's day keeps its checkpoints.
   */
  function maybeFocus() {
    if (!scenario) return;
    const t = state.playheadMs;
    if (dayOf(t) !== focusDay) {
      sendFocus(t);
      return;
    }
    if (!state.playing) return;
    const lookahead = Math.max(state.speed * FOCUS_LOOKAHEAD_WALL_MS, FOCUS_LOOKAHEAD_MIN_SIM_MS);
    const ahead = advancePlayhead(t, lookahead, scenario.sim.shift, state.computed);
    const day = dayOf(ahead.playheadMs);
    if (ahead.buffering && day !== focusDay && day !== prefetchDay) {
      prefetchDay = day;
      post({ type: 'focus', runId: state.runId, atMs: ahead.playheadMs, prefetch: true });
    }
  }

  function requestSlot(slot: DetailSlot) {
    const shift = scenario!.sim.shift;
    if (!inShift(slot.fromMs, shift) && !inShift(slot.toMs - 1, shift)) return;
    if (detail.has(slot) || !coversRange(state.computed, slot.fromMs, slot.toMs)) return;
    const requestTag = detail.begin(slot);
    post({ type: 'requestDetail', runId: state.runId, requestTag, ...slot });
  }

  /** At dot speeds in Live mode, keep per-request detail for the playhead's window and the next. */
  function maybeRequestDetail() {
    if (!scenario || state.mode !== 'live' || state.speed > dotsMaxSpeed) return;
    const t = state.playheadMs;
    const windowMs = detailWindowMs(scenario.sim.histBucketMs);
    const slot = detailSlotAt(t, windowMs);
    requestSlot(slot);
    if (t >= (slot.fromMs + slot.toMs) / 2 && slot.toMs < WEEK_MS) {
      requestSlot(detailSlotAt(slot.toMs, windowMs));
    }
  }

  // --- Worker messages --------------------------------------------------------------------------

  /** Adds current-revision data; older-revision data only where no newer fork invalidates it. */
  function accept(revision: number, chunk: ResultChunk, add: (c: ResultChunk) => void): boolean {
    if (revision > state.revision) return false;
    if (revision === state.revision) {
      add(chunk);
      return true;
    }
    const verdict = classifyOlderChunk(cuts, revision, chunk);
    if (verdict.action === 'drop') return false;
    add(chunk);
    for (const c of verdict.recut) results.cut(c.day, c.cutMs, c.lasting);
    return true;
  }

  function onProgress(revision: number, ranges: readonly ComputedRange[]) {
    if (revision !== state.revision) return;
    const computed = normalizeRanges(ranges);
    results.setComputed(computed);
    if (sameRanges(computed, state.computed)) return notify();
    setState({ computed, buffering: bufferingAt(state.playheadMs, scenario!.sim.shift, computed) });
    maybeRequestDetail();
  }

  function onMessage(msg: WorkerToMain) {
    if (disposed || !scenario || msg.runId !== state.runId) return;
    switch (msg.type) {
      case 'ready':
        if (!userTracked && msg.trackedAnalyst !== state.trackedAnalyst) {
          setState({ trackedAnalyst: msg.trackedAnalyst });
        }
        return;
      case 'error':
        onError(msg.message);
        return;
      case 'progress':
        onProgress(msg.revision, msg.computed);
        return;
      case 'chunk':
        if (accept(msg.revision, msg.chunk, (c) => results.addChunk(c))) notify();
        return;
      case 'detail': {
        const ok = accept(msg.revision, msg.chunk, (c) => results.addDetail(c));
        detail.resolve(msg.requestTag, ok && msg.revision === state.revision);
        if (ok) notify();
        return;
      }
      case 'trace':
        if (msg.analyst !== state.trackedAnalyst) return;
        if (accept(msg.revision, msg.chunk, (c) => results.addTrace(msg.day, c))) notify();
        return;
      case 'dayComplete':
        if (msg.revision > state.revision || dayInvalidated(cuts, msg.revision, msg.day)) return;
        results.addRollup(msg.day, msg.rollup);
        notify();
        return;
    }
  }

  const unsubscribeTransport = transport.onMessage(onMessage);

  // --- Actions ----------------------------------------------------------------------------------

  function startRun(s: Scenario, kind: 'init' | 'reset') {
    scenario = s;
    const runId = ++runCounter;
    const entry = s.entry.atMs;
    cuts = [];
    detail.clear();
    userTracked = false;
    focusDay = dayOf(entry);
    prefetchDay = null;
    results.reset(s.sim.replicas);
    setState({
      scenarioId: s.id,
      runId,
      revision: 0,
      playheadMs: entry,
      playing: false,
      speed: clampSpeed(s.entry.speed),
      mode: 'live',
      buffering: bufferingAt(entry, s.sim.shift, []),
      computed: [],
      forks: [],
      trackedAnalyst: null,
    });
    post(
      kind === 'init'
        ? { type: 'init', runId, scenario: toWorkerScenario(s), calibration, focusMs: entry }
        : { type: 'reset', runId, focusMs: entry },
    );
  }

  /** Moves the playhead (seek, jump) and refocuses the worker there, on any day. */
  function moveTo(atMs: SimMs, extra: Partial<PlaybackState> = {}) {
    const s = scenario!;
    const t = Math.min(WEEK_MS - 1, Math.max(0, atMs));
    setState({ ...extra, playheadMs: t, buffering: bufferingAt(t, s.sim.shift, state.computed) });
    sendFocus(t);
    maybeRequestDetail();
  }

  const store: EngineClientStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get index() {
      return results.index;
    },
    get scenario() {
      return scenario;
    },
    loadScenario(s) {
      if (!disposed) startRun(s, 'init');
    },
    play() {
      if (disposed || !scenario || state.playing) return;
      if (playableAt(state.playheadMs, scenario.sim.shift) === null) return;
      lastNow = clock.now();
      setState({ playing: true });
      scheduleFrame();
    },
    pause() {
      if (state.playing) setState({ playing: false });
    },
    setSpeed(speed) {
      const next = clampSpeed(speed);
      if (disposed || next === state.speed) return;
      setState({ speed: next });
      maybeRequestDetail();
    },
    seek(atMs) {
      if (!disposed && scenario && !Number.isNaN(atMs)) moveTo(atMs);
    },
    setMode(mode) {
      if (disposed || mode === state.mode) return;
      setState({ mode });
      maybeRequestDetail();
    },
    fork(patch, label) {
      if (disposed || !scenario) return;
      const atMs = state.playheadMs;
      const p: Patch = { ...patch, atMs };
      const revision = state.revision + 1;
      const cut: CutRecord = {
        revision,
        day: dayOf(atMs),
        cutMs: cutMsFor(atMs, scenario.sim.histBucketMs),
        lasting: isLasting(p),
      };
      cuts.push(cut);
      results.cut(cut.day, cut.cutMs, cut.lasting);
      const computed = applyCutToRanges(state.computed, cut);
      results.setComputed(computed);
      detail.cut(cut.day, cut.cutMs, cut.lasting);
      // The worker restarts on the fork's day, so that is its focus now.
      focusDay = cut.day;
      prefetchDay = null;
      setState({
        revision,
        computed,
        buffering: bufferingAt(atMs, scenario.sim.shift, computed),
        forks: [...state.forks, { atMs, revision, label }],
      });
      post({ type: 'fork', runId: state.runId, revision, patch: p });
    },
    reset() {
      if (!disposed && scenario) startRun(scenario, 'reset');
    },
    jumpToEntry() {
      if (disposed || !scenario) return;
      moveTo(scenario.entry.atMs, { playing: false, speed: clampSpeed(scenario.entry.speed) });
    },
    track(analyst) {
      if (disposed || !scenario) return;
      userTracked = true;
      if (analyst === state.trackedAnalyst) return;
      setState({ trackedAnalyst: analyst });
      post({ type: 'track', runId: state.runId, analyst });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== null) frames.cancel(frameHandle);
      frameHandle = null;
      unsubscribeTransport();
      transport.terminate();
      listeners.clear();
      frameListeners.clear();
      state = Object.freeze({ ...state, playing: false });
    },
    [FRAME_SOURCE](listener) {
      frameListeners.add(listener);
      frameDirty = true;
      scheduleFrame();
      return () => {
        frameListeners.delete(listener);
      };
    },
  };
  return store;
}
