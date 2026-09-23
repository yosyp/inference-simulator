// Open-loop session starts for one day (02 §8, K21): a bounded-rate Poisson process of candidates,
// thinned with keyed uniforms.
//
// The intensity is the piecewise-linear diurnal curve (config.diurnal.knots) cut to the analyst
// shift, times dayMultipliers[day], times the load multiplier (params.loadMultiplier × any active
// loadSpike multipliers). It is scaled so that at multiplier 1 the expected sessions per day are
// analysts × sessionsPerAnalystPerDay × dayMultipliers[day], where analysts = analystsPerReplica ×
// replicas. Starts outside the shift are dropped and the scale uses the curve's area inside it, so
// that expectation holds whatever the knots are.
//
// Candidates come from a piecewise-constant envelope that bounds the intensity at the largest
// multiplier, MAX_LOAD_MULTIPLIER. Candidate i sits at H⁻¹(E_i), where H is the envelope's
// cumulative hazard and E_i is a sum of i + 1 unit exponentials keyed by (day, candidate). So the
// candidate times depend only on (seed, config, day), never on parameters or on the simulation.
// Candidate i is accepted when u01(Source.sessionThinning, day, i) < intensity / envelope. Raising
// the multiplier mid-day therefore only adds sessions, and lowering it only removes them; every
// session accepted under both keeps its id (the candidate index), start, analyst, and script.

import type { SimConfig } from '../api.ts';
import { Source, exponential, u01 } from '../rng/index.ts';
import { DAY_MS, MINUTE_MS, dayStartMs, type DayIndex, type SimMs } from '../time.ts';

/**
 * The candidate process covers load multipliers up to this (params.loadMultiplier times active
 * loadSpike multipliers); larger products are clamped to it. Enough for a 2× drawer setting with a
 * 2× spike on top. Each session costs about 1.05 × MAX candidate events (two keyed draws each), so
 * the cap is also the cost: at 4, a Server B knee day (~56k sessions) draws ~235k candidates.
 */
export const MAX_LOAD_MULTIPLIER = 4;

/** Envelope segments are at most this long, so the envelope hugs the diurnal ramps. */
const MAX_SEGMENT_MS = 15 * MINUTE_MS;

/** Plain data; stored in the load slice. Times are absolute simulated ms. */
export interface ArrivalEnvelope {
  segStart: Float64Array;
  segEnd: Float64Array;
  /** Diurnal weight at each segment's start, and its limit at the segment's end. */
  w0: Float64Array;
  w1: Float64Array;
  /** Candidate rate per ms in each segment: scale × max(w0, w1) × MAX_LOAD_MULTIPLIER. */
  rate: Float64Array;
  /** Cumulative candidate hazard at each segment's start; one longer than the segments. */
  hazard: Float64Array;
  /** Expected sessions today at multiplier 1. */
  expectedSessions: number;
}

/** Where the candidate process stands. Plain data; stored in the load slice. */
export interface CandidateCursor {
  /** Index of the current candidate (the one at atMs); -1 before the first. */
  index: number;
  /** Cumulative envelope hazard at atMs. */
  hazard: number;
  /** Envelope segment holding atMs. */
  seg: number;
  /** Time of the current candidate; Infinity once past the last segment. */
  atMs: SimMs;
}

function fail(what: string): never {
  throw new RangeError(`Load generator config: ${what}`);
}

/** Throws a RangeError naming the first bad field the load generator depends on. */
export function validateLoadConfig(config: SimConfig): void {
  const { shift, diurnal } = config;
  if (!(shift.startMs >= 0 && shift.startMs < shift.endMs && shift.endMs <= DAY_MS)) {
    fail(`shift [${shift.startMs}, ${shift.endMs}) must lie within one day`);
  }
  let prev = -Infinity;
  for (const [t, w] of diurnal.knots) {
    if (!(t >= prev && Number.isFinite(t))) fail('diurnal knot times must be finite and sorted');
    if (!(w >= 0 && Number.isFinite(w))) fail(`diurnal knot weight ${w} must be finite and >= 0`);
    prev = t;
  }
  for (const m of diurnal.dayMultipliers) {
    if (!(m >= 0 && Number.isFinite(m))) fail(`day multiplier ${m} must be finite and >= 0`);
  }
  const counts = [config.replicas, config.analystsPerReplica, config.sessionsPerAnalystPerDay];
  if (!counts.every((n) => n >= 0 && Number.isFinite(n))) {
    fail('replicas, analystsPerReplica, and sessionsPerAnalystPerDay must be finite and >= 0');
  }
  if (!(config.thinkTimeShape > 0)) fail('thinkTimeShape must be > 0');
  if (!(config.messageTokensSigma >= 0 && config.outputTokensSigma >= 0)) {
    fail('token sigmas must be >= 0');
  }
  if (!(config.outputTokensMax >= 1)) fail('outputTokensMax must be >= 1');
}

/**
 * The day's candidate envelope. A pure function of (config, day): the diurnal curve cut to the
 * shift, split at every knot and into pieces of at most 15 minutes.
 */
export function buildEnvelope(config: SimConfig, day: DayIndex): ArrivalEnvelope {
  validateLoadConfig(config);
  const knots = config.diurnal.knots;
  const lo = config.shift.startMs;
  const hi = config.shift.endMs;
  const start: number[] = [];
  const end: number[] = [];
  const w0: number[] = [];
  const w1: number[] = [];
  let area = 0;
  for (let k = 0; k + 1 < knots.length; k++) {
    const [ta, wa] = knots[k]!;
    const [tb, wb] = knots[k + 1]!;
    const a = Math.max(ta, lo);
    const b = Math.min(tb, hi);
    if (!(b > a)) continue;
    const weightAt = (t: number) => wa + ((wb - wa) * (t - ta)) / (tb - ta);
    const pieces = Math.ceil((b - a) / MAX_SEGMENT_MS);
    for (let j = 0; j < pieces; j++) {
      const s = j === 0 ? a : a + ((b - a) * j) / pieces;
      const e = j === pieces - 1 ? b : a + ((b - a) * (j + 1)) / pieces;
      const x0 = weightAt(s);
      const x1 = weightAt(e);
      start.push(s);
      end.push(e);
      w0.push(x0);
      w1.push(x1);
      area += ((x0 + x1) / 2) * (e - s);
    }
  }
  const analysts = config.analystsPerReplica * config.replicas;
  const expectedSessions =
    analysts * config.sessionsPerAnalystPerDay * config.diurnal.dayMultipliers[day];
  const scale = area > 0 && expectedSessions > 0 ? expectedSessions / area : 0;
  const n = start.length;
  const env: ArrivalEnvelope = {
    segStart: new Float64Array(n),
    segEnd: new Float64Array(n),
    w0: Float64Array.from(w0),
    w1: Float64Array.from(w1),
    rate: new Float64Array(n),
    hazard: new Float64Array(n + 1),
    expectedSessions: scale > 0 ? expectedSessions : 0,
  };
  const dayStart = dayStartMs(day);
  for (let j = 0; j < n; j++) {
    env.segStart[j] = dayStart + start[j]!;
    env.segEnd[j] = dayStart + end[j]!;
    env.rate[j] = scale * Math.max(w0[j]!, w1[j]!) * MAX_LOAD_MULTIPLIER;
    env.hazard[j + 1] = env.hazard[j]! + env.rate[j]! * (end[j]! - start[j]!);
  }
  return env;
}

export function createCursor(): CandidateCursor {
  return { index: -1, hazard: 0, seg: 0, atMs: -Infinity };
}

/**
 * Moves the cursor to the next candidate. Returns false, with atMs = Infinity, once the candidates
 * run past the envelope's last segment.
 */
export function advanceCursor(
  env: ArrivalEnvelope,
  seed: number,
  day: DayIndex,
  c: CandidateCursor,
): boolean {
  const i = c.index + 1;
  c.index = i;
  c.hazard += exponential(u01(seed, Source.sessionStart, day, i), 1);
  const n = env.rate.length;
  while (c.seg < n && !(c.hazard < env.hazard[c.seg + 1]!)) c.seg++;
  if (c.seg >= n) {
    c.atMs = Infinity;
    return false;
  }
  // hazard[seg] <= c.hazard < hazard[seg + 1], so this segment's rate is positive.
  c.atMs = env.segStart[c.seg]! + (c.hazard - env.hazard[c.seg]!) / env.rate[c.seg]!;
  return true;
}

/** The load multiplier the candidate process honours: clamped to [0, MAX_LOAD_MULTIPLIER]. */
export function effectiveMultiplier(loadMultiplier: number, spikeProduct: number): number {
  return Math.min(MAX_LOAD_MULTIPLIER, Math.max(0, loadMultiplier * spikeProduct));
}

/** Whether the cursor's current candidate starts a session at the given effective multiplier. */
export function acceptCandidate(
  env: ArrivalEnvelope,
  seed: number,
  day: DayIndex,
  c: CandidateCursor,
  multiplier: number,
): boolean {
  const j = c.seg;
  const a = env.segStart[j]!;
  const x0 = env.w0[j]!;
  const x1 = env.w1[j]!;
  const w = x0 + ((x1 - x0) * (c.atMs - a)) / (env.segEnd[j]! - a);
  const p = (w / Math.max(x0, x1)) * (multiplier / MAX_LOAD_MULTIPLIER);
  return u01(seed, Source.sessionThinning, day, c.index) < p;
}
