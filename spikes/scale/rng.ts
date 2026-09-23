// S1 spike: a tiny keyed (counter-based) RNG. Throwaway; E1 owns the real one.
// A draw is a pure function of (seed, source, keys), mixed with Math.imul (murmur3 finalizer).

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function keyedU32(seed: number, source: number, a = 0, b = 0, c = 0): number {
  let h = fmix((seed ^ 0x9e3779b9) >>> 0);
  h = fmix((h ^ Math.imul(source + 1, 0x27d4eb2f)) >>> 0);
  h = fmix((h ^ Math.imul(a + 0x165667b1, 0x61c88647)) >>> 0);
  h = fmix((h ^ Math.imul(b + 0x2545f491, 0x1b873593)) >>> 0);
  h = fmix((h ^ Math.imul(c + 0x6c8e9cf5, 0xcc9e2d51)) >>> 0);
  return h;
}

/** Uniform in (0, 1). */
export function uniform(seed: number, source: number, a = 0, b = 0, c = 0): number {
  return (keyedU32(seed, source, a, b, c) + 0.5) / 4294967296;
}

export function normal(seed: number, source: number, a = 0, b = 0): number {
  const u1 = uniform(seed, source, a, b, 1);
  const u2 = uniform(seed, source, a, b, 2);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function lognormal(median: number, sigma: number, z: number): number {
  return median * Math.exp(sigma * z);
}

/** Geometric on {1, 2, ...} with the given mean (>= 1). */
export function geometric(mean: number, u: number): number {
  if (mean <= 1) return 1;
  const p = 1 / mean;
  return 1 + Math.floor(Math.log(u) / Math.log(1 - p));
}

// Random sources.
export const SRC = {
  sessionStart: 1,
  sessionAnalyst: 2,
  turns: 3,
  msg: 4,
  out: 5,
  think: 6,
} as const;
