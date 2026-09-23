// S1 spike: workload config, diurnal session-start schedule, and keyed session scripts.

import { HOUR_MS, MINUTE_MS } from '../../src/engine/time.ts';
import { geometric, lognormal, normal, SRC, uniform } from './rng.ts';

export interface SpikeConfig {
  seed: number;
  replicas: number;
  analystsPerReplica: number;
  /** Expected sessions per analyst on a day with multiplier 1 (before loadMultiplier). */
  sessionsPerAnalystPerDay: number;
  loadMultiplier: number;
  /** [time of day ms, relative weight]; piecewise linear, zero outside. */
  knots: readonly (readonly [number, number])[];
  dayMultipliers: readonly number[];
  systemPromptTokens: number;
  turnsPerSessionMean: number;
  messageTokensMedian: number;
  messageTokensSigma: number;
  outputTokensMedian: number;
  outputTokensSigma: number;
  outputTokensMax: number;
  thinkTimeMedianMs: number;
  thinkTimeSigma: number;
  /** Client timeout to first token (K8). No retries in the spike: a timed-out turn abandons its session. */
  timeoutToFirstTokenMs: number;
  bucketMs: number;
  histBucketMs: number;
}

// Shift 07:00-17:00 with a ramp from 06:30 (fixture shape: morning peak at 10:30, lunch dip, afternoon hump).
export const DEFAULT_KNOTS: readonly (readonly [number, number])[] = [
  [6.5 * HOUR_MS, 0],
  [7 * HOUR_MS, 0.3],
  [10.5 * HOUR_MS, 1],
  [12 * HOUR_MS, 0.7],
  [14.5 * HOUR_MS, 0.9],
  [17 * HOUR_MS, 0],
];

export function defaultConfig(overrides: Partial<SpikeConfig> = {}): SpikeConfig {
  return {
    seed: 1,
    replicas: 8,
    analystsPerReplica: 400,
    // Knee at the 10:30 peak, from run-day.ts --spa sweeps (see docs/spikes/s1-scale.md). 20 = overload case.
    sessionsPerAnalystPerDay: 16,
    loadMultiplier: 1,
    knots: DEFAULT_KNOTS,
    dayMultipliers: [0.9, 0.95, 1.1, 1, 0.85],
    systemPromptTokens: 800,
    turnsPerSessionMean: 5,
    messageTokensMedian: 150,
    messageTokensSigma: 0.8,
    outputTokensMedian: 300,
    outputTokensSigma: 0.7,
    outputTokensMax: 4096,
    thinkTimeMedianMs: 90_000,
    thinkTimeSigma: 0.6,
    timeoutToFirstTokenMs: 60_000,
    bucketMs: 10_000,
    histBucketMs: 60_000,
    ...overrides,
  };
}

/** Integral of the piecewise-linear intensity, in weight × ms. */
function knotIntegral(knots: SpikeConfig['knots']): number {
  let s = 0;
  for (let i = 1; i < knots.length; i++) {
    const [t0, w0] = knots[i - 1]!;
    const [t1, w1] = knots[i]!;
    s += ((w0 + w1) / 2) * (t1 - t0);
  }
  return s;
}

/** Inverse CDF of the diurnal density: u in (0,1) -> time of day ms. */
function diurnalInverse(knots: SpikeConfig['knots'], total: number, u: number): number {
  let target = u * total;
  for (let i = 1; i < knots.length; i++) {
    const [t0, w0] = knots[i - 1]!;
    const [t1, w1] = knots[i]!;
    const seg = ((w0 + w1) / 2) * (t1 - t0);
    if (target <= seg || i === knots.length - 1) {
      // Solve w0 x + (w1 - w0) x^2 / (2 L) = target for x in [0, L].
      const L = t1 - t0;
      const a = (w1 - w0) / (2 * L);
      let x: number;
      if (Math.abs(a) < 1e-18) x = target / w0;
      else x = (-w0 + Math.sqrt(Math.max(0, w0 * w0 + 4 * a * target))) / (2 * a);
      return t0 + Math.min(L, Math.max(0, x));
    }
    target -= seg;
  }
  return knots[knots.length - 1]![0];
}

export function diurnalWeight(knots: SpikeConfig['knots'], tod: number): number {
  for (let i = 1; i < knots.length; i++) {
    const [t0, w0] = knots[i - 1]!;
    const [t1, w1] = knots[i]!;
    if (tod >= t0 && tod <= t1) return w0 + ((w1 - w0) * (tod - t0)) / (t1 - t0);
  }
  return 0;
}

export interface SessionPlan {
  /** Session start times (sim ms), ascending; index = day-local session id. */
  startMs: Float64Array;
  analyst: Uint32Array;
}

/** Open-loop session starts for one day, keyed by (day, index). Session ids are assigned in start order. */
export function planSessions(cfg: SpikeConfig, day: number, dayStartMs: number): SessionPlan {
  const population = cfg.analystsPerReplica * cfg.replicas;
  const expected =
    population * cfg.sessionsPerAnalystPerDay * cfg.dayMultipliers[day]! * cfg.loadMultiplier;
  const n = Math.round(expected);
  const total = knotIntegral(cfg.knots);
  const tod = new Float64Array(n);
  for (let i = 0; i < n; i++) tod[i] = diurnalInverse(cfg.knots, total, uniform(cfg.seed, SRC.sessionStart, day, i));
  tod.sort();
  const startMs = new Float64Array(n);
  const analyst = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    startMs[i] = dayStartMs + tod[i]!;
    analyst[i] = Math.floor(uniform(cfg.seed, SRC.sessionAnalyst, day, i) * population);
  }
  return { startMs, analyst };
}

export function sessionTurns(cfg: SpikeConfig, day: number, session: number): number {
  return Math.min(200, geometric(cfg.turnsPerSessionMean, uniform(cfg.seed, SRC.turns, day, session)));
}

export function turnMessageTokens(cfg: SpikeConfig, day: number, session: number, turn: number): number {
  const z = normal(cfg.seed, SRC.msg, day * 1_000_000 + session, turn);
  return Math.max(4, Math.round(lognormal(cfg.messageTokensMedian, cfg.messageTokensSigma, z)));
}

export function turnOutputTokens(cfg: SpikeConfig, day: number, session: number, turn: number): number {
  const z = normal(cfg.seed, SRC.out, day * 1_000_000 + session, turn);
  return Math.min(cfg.outputTokensMax, Math.max(2, Math.round(lognormal(cfg.outputTokensMedian, cfg.outputTokensSigma, z))));
}

export function turnThinkMs(cfg: SpikeConfig, day: number, session: number, turn: number): number {
  const z = normal(cfg.seed, SRC.think, day * 1_000_000 + session, turn);
  return Math.min(30 * MINUTE_MS, Math.max(2_000, lognormal(cfg.thinkTimeMedianMs, cfg.thinkTimeSigma, z)));
}
