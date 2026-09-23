// The results index (U8): per-day storage of worker chunks and the queries renderers run on them.
// Typed arrays are kept as delivered; queries read them through small per-day time indexes.
// Revision-free: the engine client (U2) filters worker messages by revision and may re-apply a
// cut after older-revision data lands, so cut is idempotent.

import { calibration } from '../../data/calibration.ts';
import type { ResultChunk, RollupRow } from '../../engine/results.ts';
import { DAY_MS, WEEK_DAYS, WEEK_MS, type DayIndex, type SimMs } from '../../engine/time.ts';
import type { ComputedRange } from '../../worker/protocol.ts';
import type { ResultsIndex, ResultsStore } from '../types.ts';
import {
  addDetailChunk,
  addMainChunk,
  createDay,
  cutDay,
  setTrace,
  type DayData,
  type DetailEntry,
} from './day.ts';
import { requestPoints } from './records.ts';
import { sceneAt, statusAt, type StoreState } from './scene.ts';
import { quantileSeries, scalarSeries } from './series.ts';
import { addBlock, createSlotIndex, cutSlots, dropSlotDay } from './slots.ts';

export interface ResultsStoreOptions {
  /** Peak dense FLOPS of one replica's GPU, for compute utilization. Defaults to the calibration's. */
  peakFlops?: number;
  /**
   * Detail windows kept across the week; the oldest are dropped first. Unbounded by default,
   * because the engine client (U2) remembers which windows it received and never re-requests them.
   */
  maxDetailChunks?: number;
}

function subtractRange(ranges: readonly ComputedRange[], a: SimMs, b: SimMs): ComputedRange[] {
  const out: ComputedRange[] = [];
  for (const r of ranges) {
    if (r.toMs <= a || r.fromMs >= b) {
      out.push(r);
      continue;
    }
    if (r.fromMs < a) out.push({ fromMs: r.fromMs, toMs: a });
    if (r.toMs > b) out.push({ fromMs: b, toMs: r.toMs });
  }
  return out;
}

function emptyWeek<T>(): (T | null)[] {
  return Array.from({ length: WEEK_DAYS }, () => null);
}

export function createResultsStore(
  replicas: number,
  options: ResultsStoreOptions = {},
): ResultsStore {
  const maxDetails = options.maxDetailChunks ?? Infinity;
  const state: StoreState = {
    replicas,
    peakFlops: options.peakFlops ?? calibration.gpu.peakDenseFp16Flops,
    scal: createSlotIndex(),
    hist: createSlotIndex(),
    days: emptyWeek<DayData>(),
  };
  let version = 0;
  let computed: readonly ComputedRange[] = [];
  let rollups = emptyWeek<readonly RollupRow[]>();
  let rollupCache: readonly RollupRow[] | null = null;
  let completedCache: readonly DayIndex[] | null = null;
  let detailOrder: { dd: DayData; entry: DetailEntry }[] = [];

  function dayData(day: DayIndex): DayData {
    let dd = state.days[day];
    if (!dd) {
      dd = createDay(day);
      state.days[day] = dd;
    }
    return dd;
  }

  function changed(rollupsToo = false): void {
    version++;
    if (rollupsToo) {
      rollupCache = null;
      completedCache = null;
    }
  }

  const index: ResultsIndex = {
    get version() {
      return version;
    },
    get replicas() {
      return state.replicas;
    },
    computed: () => computed,
    scalarSeries: (metric, series, window, columns) =>
      scalarSeries(state.scal, metric, series, window, columns),
    quantileSeries: (metric, series, window, columns, quantiles) =>
      quantileSeries(state.hist, metric, series, window, columns, quantiles),
    requestPoints: (window) => requestPoints(state.days, window),
    sceneAt: (atMs, opts) => sceneAt(state, atMs, opts),
    statusAt: (atMs) => statusAt(state, atMs),
    rollup() {
      rollupCache ??= rollups
        .flatMap((rows) => rows ?? [])
        .sort((a, b) => a.day - b.day || a.replica - b.replica);
      return rollupCache;
    },
    completedDays() {
      completedCache ??= rollups.flatMap((rows, d) => (rows ? [d as DayIndex] : []));
      return completedCache;
    },
  };

  return {
    index,
    reset(n: number) {
      state.replicas = n;
      state.scal = createSlotIndex();
      state.hist = createSlotIndex();
      state.days = emptyWeek<DayData>();
      computed = [];
      rollups = emptyWeek<readonly RollupRow[]>();
      detailOrder = [];
      changed(true);
    },
    addChunk(chunk: ResultChunk) {
      addBlock(state.scal, chunk.day, chunk.scalars);
      addBlock(state.hist, chunk.day, chunk.histograms);
      addMainChunk(dayData(chunk.day), chunk);
      changed();
    },
    addDetail(chunk: ResultChunk) {
      const dd = dayData(chunk.day);
      detailOrder.push({ dd, entry: addDetailChunk(dd, chunk) });
      while (detailOrder.length > maxDetails) {
        const old = detailOrder.shift()!;
        old.dd.details = old.dd.details.filter((e) => e !== old.entry);
      }
      changed();
    },
    addTrace(day: DayIndex, chunk: ResultChunk) {
      setTrace(dayData(day), chunk);
      changed();
    },
    addRollup(day: DayIndex, rows: readonly RollupRow[]) {
      rollups[day] = rows.slice();
      changed(true);
    },
    setComputed(ranges: readonly ComputedRange[]) {
      computed = ranges.map((r) => ({ fromMs: r.fromMs, toMs: r.toMs }));
      changed();
    },
    cut(day: DayIndex, cutMs: SimMs, lasting: boolean) {
      const dayEnd = (day + 1) * DAY_MS;
      const dd = state.days[day];
      if (dd) cutDay(dd, cutMs);
      cutSlots(state.scal, day, cutMs);
      cutSlots(state.hist, day, cutMs);
      rollups[day] = null;
      // The discarded time is no longer computed. (U2 also calls setComputed right after a cut.)
      computed = subtractRange(computed, Math.max(cutMs, day * DAY_MS), dayEnd);
      if (lasting) {
        for (let d = day + 1; d < WEEK_DAYS; d++) {
          state.days[d] = null;
          dropSlotDay(state.scal, d as DayIndex);
          dropSlotDay(state.hist, d as DayIndex);
          rollups[d] = null;
        }
        computed = subtractRange(computed, dayEnd, WEEK_MS);
      }
      detailOrder = detailOrder.filter(
        (o) => state.days[o.dd.day] === o.dd && o.dd.details.includes(o.entry),
      );
      changed(true);
    },
  };
}
