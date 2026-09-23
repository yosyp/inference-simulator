// A fake ResultsIndex computed analytically from synthetic signals. Renderers (U3, U4, U5, U6, U7)
// build and test against it until U2's real index is wired to the engine (X1).

import type { HistogramMetric } from '../engine/histogram.ts';
import {
  REPLICA_STATE,
  SCALAR_METRICS,
  type RollupRow,
  type ScalarMetric,
} from '../engine/results.ts';
import {
  DAY_MS,
  WEEK_DAYS,
  WEEK_MS,
  rollupDeliveryMs,
  type DayIndex,
  type SimMs,
} from '../engine/time.ts';
import type {
  DotView,
  QuantileData,
  ReplicaView,
  RequestPoints,
  ResultsIndex,
  SceneState,
  SeriesData,
  StatusSnapshot,
  TimeWindow,
} from '../playback/types.ts';
import { FIXTURE_TRACKED_ANALYST } from './chunks.ts';
import { hash01, replicaPhase, signals, type FixtureOptions } from './synthetic.ts';

const BASE_STEP_MS = 10_000;

// Inverse normal CDF at common quantiles (for lognormal quantiles).
const Z: Record<string, number> = { '0.5': 0, '0.9': 1.2816, '0.95': 1.6449, '0.99': 2.3263 };
function zOf(q: number): number {
  return Z[String(q)] ?? 0;
}

function perSecondRate(opts: FixtureOptions, metric: ScalarMetric, r: number, t: number): number {
  const s = signals(opts, r, t);
  const served = s.requestsPerMin / 60;
  switch (metric) {
    case 'kvUsedFrac':
    case 'kvUsedFracMax':
      return s.kvUsedFrac;
    case 'running':
      return s.running;
    case 'waiting':
      return s.waiting;
    case 'outstanding':
      return s.running + s.waiting;
    case 'preemptions':
      return s.preemptionsPerMin / 60;
    case 'busyMs':
      return s.nvidiaSmiUtil * 1000;
    case 'flops':
      return s.computeUtil * 312e12;
    case 'decodeTokens':
      return served * 300;
    case 'prefillTokens':
      return served * 1200;
    case 'recomputedPrefillTokens':
      return s.preemptionsPerMin > 0 ? served * 200 : 0;
    case 'prefixQueryTokens':
    case 'returningQueryTokens':
      return served * 2000;
    case 'prefixHitTokens':
    case 'returningHitTokens':
      return served * 800;
    case 'dispatched':
    case 'finished':
    case 'ttftCount':
    case 'tpotCount':
    case 'e2eCount':
    case 'offered':
    case 'organic':
      return served;
    case 'ttftSumMs':
      return served * s.ttftMedianMs * 1.3;
    case 'tpotSumMs':
      return served * s.tpotMedianMs;
    case 'e2eSumMs':
      return served * (s.ttftMedianMs * 1.3 + 300 * s.tpotMedianMs);
    default:
      return 0;
  }
}

function stepFor(window: TimeWindow, columns: number): number {
  const raw = (window.toMs - window.fromMs) / Math.max(1, columns);
  return Math.max(BASE_STEP_MS, Math.ceil(raw / BASE_STEP_MS) * BASE_STEP_MS);
}

function dotState(progress: number): DotView['state'] {
  return progress < 0.15 ? 'prefill' : 'decode';
}

export function createFakeIndex(opts: FixtureOptions): ResultsIndex {
  const replicas = opts.replicas;

  function valueAt(metric: ScalarMetric, series: number, t: number, stepMs: number): number {
    const agg = SCALAR_METRICS[metric];
    const rs = series === 0 ? [...Array(replicas).keys()] : [series - 1];
    let v = 0;
    for (const r of rs) {
      const x = perSecondRate(opts, metric, r, t);
      v += agg === 'sum' ? (x * stepMs) / 1000 : x;
    }
    if (series === 0 && metric === 'kvUsedFrac') v /= replicas;
    if (metric === 'readyReplicas') {
      v = rs.filter((r) => replicaPhase(opts, r, t).phase === 'ready').length;
    }
    return v;
  }

  function sceneAt(
    atMs: SimMs,
    o: { mode: SceneState['mode']; detail: SceneState['detail']; trackedAnalyst: number | null },
  ): SceneState {
    const views: ReplicaView[] = [];
    for (let r = 0; r < replicas; r++) {
      const snap = statusAt(atMs).replicas[r]!;
      const dots: DotView[] = [];
      if (o.detail === 'dots' && o.mode === 'live') {
        const slots = snap.running + snap.waiting;
        for (let i = 0; i < slots; i++) {
          const period = 20_000 + 30_000 * hash01(r, i);
          const phase = hash01(i, r, 9);
          const cycle = Math.floor(atMs / period + phase);
          const progress = atMs / period + phase - cycle;
          const queued = i >= snap.running;
          const preempted = queued && snap.preemptionsPerMin > 0 && i % 5 === 0;
          const id = Math.floor(hash01(r, i, cycle) * 1e9);
          dots.push({
            request: id,
            analyst: Math.floor(hash01(id, 1) * 500),
            state: preempted ? 'preempted' : queued ? 'queued' : dotState(progress),
            progress,
            tracked: false,
          });
        }
      }
      views.push({ ...snap, dots });
    }
    return {
      atMs,
      mode: o.mode,
      detail: o.detail,
      router: { atRouter: [], offeredPerS: statusAt(atMs).fleet.offeredPerS },
      replicas: views,
      tracked:
        o.trackedAnalyst === null
          ? null
          : {
              analyst: o.trackedAnalyst,
              requests: [1, 2, 3].map((turn) => ({
                request: turn,
                turn,
                replica: turn % replicas,
                state: 'finished' as const,
                ttftMs: 120 * turn,
                tpotMs: 17,
                moved: turn > 1 && replicas > 1,
              })),
            },
    };
  }

  function statusAt(atMs: SimMs): StatusSnapshot {
    const reps = [...Array(replicas).keys()].map((r) => {
      const s = signals(opts, r, atMs);
      const p = replicaPhase(opts, r, atMs);
      return {
        replica: r,
        state: REPLICA_STATE[p.phase],
        phaseProgress: p.progress,
        kvUsedFrac: s.kvUsedFrac,
        running: s.running,
        waiting: s.waiting,
        preemptionsPerMin: s.preemptionsPerMin,
        prefillTokensPerS: (s.requestsPerMin / 60) * 1200,
        decodeTokensPerS: (s.requestsPerMin / 60) * 300,
        nvidiaSmiUtil: s.nvidiaSmiUtil,
        computeUtil: s.computeUtil,
      };
    });
    const offered = reps.reduce((a, r) => a + r.decodeTokensPerS / 300, 0);
    return {
      atMs,
      replicas: reps,
      fleet: {
        offeredPerS: offered,
        admittedPerS: offered,
        rejectedPerS: 0,
        amplification: 1,
        ttftP99Ms: Math.max(...reps.map((_, r) => signals(opts, r, atMs).ttftMedianMs)) * 5,
        abandonedSessions: 0,
      },
    };
  }

  return {
    version: 1,
    replicas,
    computed: () => [{ fromMs: 0, toMs: WEEK_MS }],
    scalarSeries(metric, series, window, columns): SeriesData {
      const stepMs = stepFor(window, columns);
      const n = Math.max(0, Math.ceil((window.toMs - window.fromMs) / stepMs));
      const t = new Float64Array(n);
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        t[i] = window.fromMs + i * stepMs;
        v[i] = valueAt(metric, series, t[i]! + stepMs / 2, stepMs);
      }
      return { t, stepMs, v };
    },
    quantileSeries(metric: HistogramMetric, series, window, columns, quantiles): QuantileData {
      const stepMs = stepFor(window, columns);
      const n = Math.max(0, Math.ceil((window.toMs - window.fromMs) / stepMs));
      const t = new Float64Array(n);
      const counts = new Float64Array(n);
      const values = quantiles.map(() => new Float64Array(n));
      const sigma = metric === 'tpot' ? 0.15 : metric === 'e2e' ? 0.6 : 0.7;
      for (let i = 0; i < n; i++) {
        t[i] = window.fromMs + i * stepMs;
        const mid = t[i]! + stepMs / 2;
        const rs = series === 0 ? [...Array(replicas).keys()] : [series - 1];
        const medians = rs.map((r) => {
          const s = signals(opts, r, mid);
          return metric === 'tpot'
            ? s.tpotMedianMs
            : metric === 'e2e'
              ? s.ttftMedianMs + 300 * s.tpotMedianMs
              : s.ttftMedianMs;
        });
        counts[i] = rs.reduce(
          (a, r) => a + (signals(opts, r, mid).requestsPerMin * stepMs) / 60_000,
          0,
        );
        const median = Math.max(...medians);
        quantiles.forEach((q, k) => {
          values[k]![i] = counts[i]! > 0 ? median * Math.exp(sigma * zOf(q)) : NaN;
        });
      }
      return { t, stepMs, values, counts };
    },
    requestPoints(window): RequestPoints {
      const spacing = 20_000;
      const first = Math.ceil(window.fromMs / spacing) * spacing;
      const n = Math.max(0, Math.ceil((window.toMs - first) / spacing));
      const pts: RequestPoints = {
        t: new Float64Array(n),
        ttftMs: new Float64Array(n),
        tpotMs: new Float64Array(n),
        e2eMs: new Float64Array(n),
        replica: new Int8Array(n),
        analyst: new Uint32Array(n),
      };
      for (let i = 0; i < n; i++) {
        const t = first + i * spacing;
        const r = i % replicas;
        const s = signals(opts, r, t);
        pts.t[i] = t;
        pts.ttftMs[i] = s.ttftMedianMs * (0.5 + hash01(i, 11));
        pts.tpotMs[i] = s.tpotMedianMs;
        pts.e2eMs[i] = pts.ttftMs[i]! + 300 * s.tpotMedianMs;
        pts.replica[i] = r;
        pts.analyst[i] = FIXTURE_TRACKED_ANALYST;
      }
      return pts;
    },
    sceneAt,
    statusAt,
    rollup(): RollupRow[] {
      const rows: RollupRow[] = [];
      for (let day = 0; day < WEEK_DAYS; day++) {
        for (let r = 0; r < replicas; r++) {
          let served = 0;
          let e2e = 0;
          let util = 0;
          const samples = 144;
          for (let k = 0; k < samples; k++) {
            const t = day * DAY_MS + (k + 0.5) * (DAY_MS / samples);
            const s = signals(opts, r, t);
            const n = (s.requestsPerMin * (DAY_MS / samples)) / 60_000;
            served += n;
            e2e += n * (s.ttftMedianMs * 1.3 + 300 * s.tpotMedianMs);
            util += s.nvidiaSmiUtil / samples;
          }
          const d = day as DayIndex;
          rows.push({
            day: d,
            replica: r,
            requestsServed: Math.round(served),
            meanE2eMs: served > 0 ? e2e / served : NaN,
            meanNvidiaSmiUtil: util,
            deliveredAtMs: rollupDeliveryMs(d),
          });
        }
      }
      return rows;
    },
    completedDays: () => [0, 1, 2, 3, 4],
  };
}
