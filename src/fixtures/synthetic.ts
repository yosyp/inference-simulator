// Deterministic synthetic signals shared by the fixture chunks and the fake index.
// Plausible shapes only (a diurnal curve, a KV ramp, a crash); not a simulation.

import { DAY_MS, HOUR_MS, timeOfDayMs, type SimMs } from '../engine/time.ts';

export interface FixtureOptions {
  replicas: number;
  /** Optional crash: the replica goes down, then loads and rejoins. */
  crash?: { replica: number; atMs: SimMs };
}

export const FIXTURE_SHIFT = { startMs: 7 * HOUR_MS, endMs: 17 * HOUR_MS };
export const FIXTURE_DETECT_MS = 10_000;
export const FIXTURE_LOAD_MS = 25_000;
export const FIXTURE_INIT_MS = 90_000;

/** Stateless hash to [0, 1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h =
    Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Standard normal from two hashed uniforms (Box–Muller). */
export function normal(a: number, b: number): number {
  const u = Math.max(hash01(a, b, 1), 1e-12);
  const v = hash01(a, b, 2);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Relative load 0..1 over the shift: a morning peak at 10:30 and a smaller one at 14:30. */
export function diurnal(t: SimMs): number {
  const h = timeOfDayMs(t) / HOUR_MS;
  if (h < 7 || h >= 17) return 0;
  const bump = (center: number, width: number) => Math.exp(-(((h - center) / width) ** 2));
  const day = Math.floor(t / DAY_MS);
  const dayScale = [0.85, 0.9, 1.0, 0.95, 0.8][day] ?? 0.9;
  return Math.min(1, dayScale * (0.25 + 0.75 * Math.max(bump(10.5, 1.6), 0.85 * bump(14.5, 1.4))));
}

export type ReplicaPhase = 'ready' | 'crashed' | 'down' | 'loadingWeights' | 'initializingEngine';

export function replicaPhase(
  opts: FixtureOptions,
  replica: number,
  t: SimMs,
): { phase: ReplicaPhase; progress: number | null } {
  const c = opts.crash;
  if (!c || c.replica !== replica || t < c.atMs) return { phase: 'ready', progress: null };
  const dt = t - c.atMs;
  if (dt < FIXTURE_DETECT_MS) return { phase: 'crashed', progress: null };
  const loadStart = FIXTURE_DETECT_MS + 60_000;
  if (dt < loadStart) return { phase: 'down', progress: null };
  if (dt < loadStart + FIXTURE_LOAD_MS) {
    return { phase: 'loadingWeights', progress: (dt - loadStart) / FIXTURE_LOAD_MS };
  }
  if (dt < loadStart + FIXTURE_LOAD_MS + FIXTURE_INIT_MS) {
    return {
      phase: 'initializingEngine',
      progress: (dt - loadStart - FIXTURE_LOAD_MS) / FIXTURE_INIT_MS,
    };
  }
  return { phase: 'ready', progress: null };
}

/** Per-replica utilization 0..1, raised on survivors while a replica is out. */
export function replicaLoad(opts: FixtureOptions, replica: number, t: SimMs): number {
  if (replicaPhase(opts, replica, t).phase !== 'ready') return 0;
  let out = 0;
  if (opts.crash) {
    for (let r = 0; r < opts.replicas; r++) {
      if (replicaPhase(opts, r, t).phase !== 'ready') out++;
    }
  }
  const share = opts.replicas / Math.max(1, opts.replicas - out);
  const skew = 1 + 0.08 * Math.sin(replica * 1.7 + t / (37 * 60_000));
  return Math.min(1, diurnal(t) * 0.92 * share * skew);
}

export interface ReplicaSignals {
  kvUsedFrac: number;
  running: number;
  waiting: number;
  preemptionsPerMin: number;
  ttftMedianMs: number;
  tpotMedianMs: number;
  requestsPerMin: number;
  nvidiaSmiUtil: number;
  computeUtil: number;
}

export function signals(opts: FixtureOptions, replica: number, t: SimMs): ReplicaSignals {
  const u = replicaLoad(opts, replica, t);
  const kv = u === 0 ? 0 : Math.min(0.985, 0.2 + 0.8 * u * u);
  const pressure = Math.max(0, u - 0.85) / 0.15;
  return {
    kvUsedFrac: kv,
    running: Math.round(40 * u),
    waiting: Math.round(60 * pressure * pressure),
    preemptionsPerMin: kv > 0.95 ? 6 * pressure : 0,
    ttftMedianMs: 60 / Math.max(0.04, 1 - Math.min(u, 0.96)),
    tpotMedianMs: 14 + 10 * u,
    requestsPerMin: 180 * u,
    nvidiaSmiUtil: u === 0 ? 0 : Math.min(0.99, 0.15 + 0.95 * u),
    computeUtil: 0.05 + 0.3 * u,
  };
}
