/**
 * Keyed randomness for the engine (02-simulator §12, K6). This module is the only source of
 * randomness in src/engine.
 *
 * A draw is a pure function of (seed, source, keys). There is no generator object and no stream
 * position, so engine state holds no RNG state and draws never depend on the order the simulation
 * asks for them. The same (session, turn) gets the same lengths under every routing policy, which
 * keeps policy comparisons paired.
 *
 * Two layers:
 * - `u01(seed, source, k0, …, k5)` returns a uniform in [0, 1) (53 bits); `u32` returns 32 bits
 *   for hashing. Keys are integers in [0, 2^32), and omitted keys are 0.
 * - Transforms turn one uniform into one draw by inverse CDF: `uniform`, `uniformInt`,
 *   `exponential`, `lognormal`, `geometric`, `logLogistic`, and `weightedIndex`.
 *
 * Rules:
 * - Use a `Source` per kind of draw, and one fixed key layout per source. Add a source rather than
 *   overloading one (sources.ts is append-only).
 * - Key by the entity the draw belongs to (session, turn, request, attempt, replica), never by a
 *   counter of how many draws came before. Include the day when the id is day-local.
 * - Draw each value from its own key. One key must not feed two transforms; add a key word instead
 *   (e.g. an index), or use another source.
 * - Hot path: fixed arity, no allocation, no rest or spread arguments. Pass integers, not strings.
 *
 * @example Session script at creation (E6): every length and pause is fixed by the key alone.
 * ```ts
 * import { Source, geometric, logLogistic, lognormal, u01 } from '../rng/index.ts';
 *
 * const turns = geometric(u01(seed, Source.turns, day, session), p.turnsPerSessionMean);
 * for (let turn = 0; turn < turns; turn++) {
 *   const uMessage = u01(seed, Source.messageLength, day, session, turn);
 *   const uThink = u01(seed, Source.thinkTime, day, session, turn);
 *   const messageTokens = Math.max(
 *     1,
 *     Math.round(lognormal(uMessage, p.messageTokensMedian, cfg.messageTokensSigma)),
 *   );
 *   const thinkMs = logLogistic(uThink, p.thinkTimeMedianMs, cfg.thinkTimeShape);
 * }
 * ```
 *
 * @example Retry jitter keyed by (request, attempt) (K8), full-jitter backoff:
 * ```ts
 * const capMs = Math.min(p.retryCapMs, p.retryBaseMs * 2 ** attempt);
 * const delayMs = uniform(u01(seed, Source.retryJitter, day, request, attempt), 0, capMs);
 * ```
 *
 * @example Weighted choice with a reused scratch array:
 * ```ts
 * const cumulative = cumulativeWeights(weights, scratch); // once per weight change
 * const u = u01(seed, Source.sessionAnalyst, day, session);
 * const i = weightedIndex(u, cumulative, weights.length);
 * ```
 *
 * @example Thinning with a keyed uniform, so raising the rate adds sessions without moving others:
 * ```ts
 * const u = u01(seed, Source.sessionThinning, day, candidate);
 * const keep = u < loadMultiplier / maxMultiplier;
 * ```
 *
 * @example Hash positions for a consistent-hash ring (E7):
 * ```ts
 * const position = u32(seed, Source.hashRing, replica, vnode);
 * ```
 */

export { u01, u32 } from './keyed.ts';
export { normalQuantile } from './normal.ts';
export { Source, type SourceName } from './sources.ts';
export {
  cumulativeWeights,
  exponential,
  geometric,
  logLogistic,
  logLogisticMean,
  lognormal,
  lognormalMean,
  uniform,
  uniformInt,
  weightedIndex,
} from './distributions.ts';
