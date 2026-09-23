// Keyed, counter-based random draws (02-simulator §12, K6).
//
// A draw is a pure function of (seed, source, k0 … k5). There is no stream state, so callers never
// hold RNG state and engine state stays plain data. A draw for (session 17, turn 3) is the same no
// matter when, or in what order, the simulation asks for it. That is what keeps policy comparisons
// paired.
//
// Construction. Two 32-bit lanes each absorb the eight input words in order (seed, source, k0 … k5):
// XOR the word in, then apply the lane's bijective xorshift-multiply mixer. A two-round Feistel
// cross-mix then makes every output bit depend on both lanes. Each absorb step is a bijection of
// the lane for a fixed word, so two inputs that differ in exactly one word never collide. Only
// Math.imul, ^, and >>> touch the bits, so the integers are identical in every JS engine; u01
// scales 53 of the 64 output bits by 2^-53, which is exact.
//
// Mixers, both full-avalanche 32-bit permutations:
//   lane A: [16 21f0aaad 15 735a2d97 15], a low-bias mixer from Chris Wellons' hash-prospector;
//   lane B: [16 85ebca6b 13 c2b2ae35 16], the MurmurHash3 fmix32 finalizer.
// They are written out inline below because V8 does not inline 18 small calls into one function,
// which halves throughput. keyed.test.ts checks this kernel against a plain reference version.
//
// Frozen: changing any constant here changes every simulated run. keyed.test.ts pins golden values.

import type { Source } from './sources.ts';

const imul = Math.imul;

// Lane A and lane B mixer multipliers.
const A1 = 0x21f0aaad;
const A2 = 0x735a2d97;
const B1 = 0x85ebca6b;
const B2 = 0xc2b2ae35;
/** Lane starting values: the first two SHA-256 initial hash words. */
const IV_A = 0x6a09e667;
const IV_B = 0xbb67ae85;
/** Cross-mix tweaks (the next two SHA-256 words), so the Feistel rounds differ from absorb steps. */
const TWEAK_A = 0x3c6ef372;
const TWEAK_B = 0xa54ff53a;

const TWO_POW_26 = 67_108_864;
const TWO_POW_32 = 4_294_967_296;
/** 2^-53. */
const TWO_POW_M53 = 1.1102230246251565e-16;

/**
 * A uniform double in [0, 1) with 53 random bits, keyed by (seed, source, k0 … k5). The result is
 * a multiple of 2^-53 built from two 32-bit words, so it is bit-identical in every JS engine.
 *
 * Every argument is read as a 32-bit integer (ToInt32), so pass integers in [0, 2^32): fractions
 * truncate and larger values wrap. Omitted keys are 0, so `u01(s, src, 5)` equals
 * `u01(s, src, 5, 0)`. Give each source one fixed key layout.
 *
 * Feed the result to one inverse-CDF transform from distributions.ts: one uniform per draw.
 */
export function u01(
  seed: number,
  source: Source,
  k0 = 0,
  k1 = 0,
  k2 = 0,
  k3 = 0,
  k4 = 0,
  k5 = 0,
): number {
  let a = IV_A ^ seed;
  let b = IV_B ^ seed;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= source;
  b ^= source;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k0;
  b ^= k0;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k1;
  b ^= k1;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k2;
  b ^= k2;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k3;
  b ^= k3;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k4;
  b ^= k4;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  a ^= k5;
  b ^= k5;
  a = imul(a ^ (a >>> 16), A1);
  a = imul(a ^ (a >>> 15), A2);
  a ^= a >>> 15;
  b = imul(b ^ (b >>> 16), B1);
  b = imul(b ^ (b >>> 13), B2);
  b ^= b >>> 16;

  // Feistel cross-mix: b ^= mixA(a ^ TWEAK_A), then a ^= mixB(b ^ TWEAK_B).
  let t = a ^ TWEAK_A;
  t = imul(t ^ (t >>> 16), A1);
  t = imul(t ^ (t >>> 15), A2);
  b ^= t ^ (t >>> 15);
  t = b ^ TWEAK_B;
  t = imul(t ^ (t >>> 16), B1);
  t = imul(t ^ (t >>> 13), B2);
  a ^= t ^ (t >>> 16);

  return ((a >>> 5) * TWO_POW_26 + (b >>> 6)) * TWO_POW_M53;
}

/**
 * A uniform 32-bit unsigned integer keyed by (seed, source, k0 … k5): the top 32 of the 53 bits
 * that `u01` returns for the same arguments, so don't use both on one key. Bit-identical in every
 * JS engine. Use it for hashing, e.g. consistent-hash ring positions; use `u01` for probabilities.
 */
export function u32(
  seed: number,
  source: Source,
  k0 = 0,
  k1 = 0,
  k2 = 0,
  k3 = 0,
  k4 = 0,
  k5 = 0,
): number {
  // Scaling by 2^32 and flooring are exact.
  return Math.floor(u01(seed, source, k0, k1, k2, k3, k4, k5) * TWO_POW_32);
}
