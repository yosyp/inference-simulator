// Runs one scenario day headless (E11 runHeadless) for the lesson assertions and pnpm sim (C1).
//
//   const r = runScenarioDay(scenario);                    // the lesson moment's day
//   r.index.quantileSeries('ttft', FLEET_SERIES, w, 60, [0.99])   // any chart query (U8)
//   ttftStatsInWindow(r, before(r.momentMs, 15 * MINUTE_MS))      // lesson helpers (lessons.ts)
//   returningTurnHitRate(r.records, arrivedIn(after(r.momentMs)))  // record helpers (records.ts)

import { calibration as appCalibration } from '../../data/calibration.ts';
import type { AnalystId, Patch, SimConfig, TunableParams } from '../../engine/api.ts';
import type { Calibration } from '../../engine/calibration.ts';
import { runHeadless } from '../../engine/headless.ts';
import type { ResultChunk, RollupRow } from '../../engine/results.ts';
import {
  dayOf,
  dayStartMs,
  isDayIndex,
  timeOfDayMs,
  type DayIndex,
  type SimMs,
} from '../../engine/time.ts';
import { createResultsStore } from '../../playback/index/index.ts';
import type { ResultsIndex } from '../../playback/types.ts';
import type { Scenario } from '../schema.ts';

/** What the window helpers read (lessons.ts): chunks in time order and the GPU's peak FLOPS. */
export interface ChunkRun {
  chunks: readonly ResultChunk[];
  replicas: number;
  /** One replica's peak dense FLOPS, for compute utilization. */
  peakFlops: number;
}

/** One request attempt's record (results.ts RequestBlock), as a plain object. */
export interface RequestRecord {
  id: number;
  session: number;
  analyst: AnalystId;
  /** 1-based; turn >= 2 is a returning turn. */
  turn: number;
  /** 0 for the first attempt. */
  attempt: number;
  /** -1 if never dispatched. */
  replica: number;
  /** Replica that served the session's previous turn; -1 on the first turn. */
  prevReplica: number;
  arriveMs: SimMs;
  dispatchMs: SimMs;
  firstTokenMs: SimMs;
  endMs: SimMs;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  preemptions: number;
  /** OUTCOME code (results.ts): finished 5, rejected 6, timedOut 7, failed 8. */
  outcome: number;
}

export interface RunScenarioDayOptions {
  /** Default: the lesson moment's day. */
  day?: DayIndex;
  /** Appended to the scenario's baseline patches, so they win at equal times. */
  patches?: readonly Patch[];
  /** Default 'all': every request's records. 'tracked' keeps only the tracked analyst's. */
  detail?: 'all' | 'tracked';
  /** Stop at this time of day (ms after midnight). Default: the day's end. */
  untilTimeOfDayMs?: number;
  /** Default: the app's calibration (provisional until B3 lands). */
  calibration?: Calibration;
}

export interface ScenarioDayResult extends ChunkRun {
  scenario: Scenario;
  day: DayIndex;
  /** The lesson moment moved onto `day` (same time of day). */
  momentMs: SimMs;
  config: SimConfig;
  calibration: Calibration;
  /** Every patch the run used: baseline, then options.patches. */
  patches: readonly Patch[];
  detail: 'all' | 'tracked';
  trackedAnalyst: AnalystId | null;
  /** U8's results index over the chunks: scalarSeries, quantileSeries, requestPoints, statusAt, rollup. */
  index: ResultsIndex;
  /** Records in chunk order (by outcome time); scope as `detail`. */
  records: RequestRecord[];
  /** Null when the run stopped before the day's end. */
  rollup: RollupRow[] | null;
  simMs: number;
  wallMs: number;
}

/** A 'set' patch at the start of `day`, e.g. from pnpm sim --patch. */
export function setPatchAtDayStart(day: DayIndex, changes: Partial<TunableParams>): Patch {
  return { kind: 'set', atMs: dayStartMs(day), changes };
}

/** Flattens the chunks' request blocks into records, in chunk order. */
export function collectRecords(chunks: readonly ResultChunk[]): RequestRecord[] {
  const out: RequestRecord[] = [];
  for (const c of chunks) {
    const b = c.requests;
    for (let k = 0; k < b.count; k++) {
      out.push({
        id: b.id[k]!,
        session: b.session[k]!,
        analyst: b.analyst[k]!,
        turn: b.turn[k]!,
        attempt: b.attempt[k]!,
        replica: b.replica[k]!,
        prevReplica: b.prevReplica[k]!,
        arriveMs: b.arriveMs[k]!,
        dispatchMs: b.dispatchMs[k]!,
        firstTokenMs: b.firstTokenMs[k]!,
        endMs: b.endMs[k]!,
        promptTokens: b.promptTokens[k]!,
        cachedTokens: b.cachedTokens[k]!,
        outputTokens: b.outputTokens[k]!,
        preemptions: b.preemptions[k]!,
        outcome: b.outcome[k]!,
      });
    }
  }
  return out;
}

/** Runs one day of the scenario from its morning (K21), headless, and indexes the output. */
export function runScenarioDay(
  scenario: Scenario,
  options: RunScenarioDayOptions = {},
): ScenarioDayResult {
  const day = options.day ?? dayOf(scenario.lessonMoment.atMs);
  if (!isDayIndex(day)) throw new RangeError(`Day ${day} is not a work-week day`);
  const cal = options.calibration ?? appCalibration;
  const config = scenario.sim;
  const patches = [...scenario.baselinePatches, ...(options.patches ?? [])];
  const detail = options.detail ?? 'all';
  const run = runHeadless({
    config,
    calibration: cal,
    patches,
    days: day,
    detail,
    tracked: scenario.tracked,
    untilTimeOfDayMs: options.untilTimeOfDayMs,
    now: () => performance.now(),
  });
  const d = run.days[0]!;
  const store = createResultsStore(config.replicas, { peakFlops: cal.gpu.peakDenseFp16Flops });
  for (const c of d.chunks) store.addChunk(c);
  if (d.rollup) store.addRollup(day, d.rollup);
  store.setComputed([{ fromMs: dayStartMs(day), toMs: dayStartMs(day) + d.simMs }]);
  return {
    scenario,
    day,
    momentMs: dayStartMs(day) + timeOfDayMs(scenario.lessonMoment.atMs),
    config,
    calibration: cal,
    patches,
    detail,
    trackedAnalyst: run.trackedAnalyst,
    chunks: d.chunks,
    replicas: config.replicas,
    peakFlops: cal.gpu.peakDenseFp16Flops,
    index: store.index,
    records: collectRecords(d.chunks),
    rollup: d.rollup,
    simMs: d.simMs,
    wallMs: d.wallMs,
  };
}
