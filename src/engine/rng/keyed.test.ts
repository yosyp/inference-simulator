import { describe, expect, it } from 'vitest';
import { u01, u32 } from './keyed.ts';
import { Source } from './sources.ts';

const N = 100_000;
/** Five standard errors of a sample correlation over N pairs. */
const CORR_TOL = 5 / Math.sqrt(N);

/** Any source number, for tests that sweep the source word. */
const src = (n: number) => n as Source;

/** Draw from all eight input words, in order (seed, source, k0 … k5). */
function draw(w: ArrayLike<number>): number {
  return u01(w[0]!, src(w[1]!), w[2], w[3], w[4], w[5], w[6], w[7]);
}

// The construction written plainly (helper mixers, a loop over words), to check the inlined kernel.
function mixA(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97);
  return x ^ (x >>> 15);
}
function mixB(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return x ^ (x >>> 16);
}
function reference(words: ArrayLike<number>): number {
  let a = 0x6a09e667;
  let b = 0xbb67ae85;
  for (let i = 0; i < 8; i++) {
    const w = i < words.length ? words[i]! : 0;
    a = mixA(a ^ w);
    b = mixB(b ^ w);
  }
  b ^= mixA(a ^ 0x3c6ef372);
  a ^= mixB(b ^ 0xa54ff53a);
  return ((a >>> 5) * 2 ** 26 + (b >>> 6)) / 2 ** 53;
}

/** Test-input generator (xorshift32), independent of the code under test. */
function xorshift(state: number): () => number {
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function correlation(x: Float64Array, y: Float64Array): number {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < x.length; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= x.length;
  my /= y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

describe('keyed draws: determinism', () => {
  it('matches golden values from an independent uint32 implementation', () => {
    // [input words, u01 · 2^53, u32]. Computed in Python with explicit uint32 arithmetic; any change
    // here changes every simulated run.
    const golden: [number[], number, number][] = [
      [[0, 0], 5325854840178721, 2539565486],
      [[0, 1], 5619724995267999, 2679693696],
      [[1, 1], 3320303738631513, 1583244199],
      [[42, 5, 2, 17, 3], 4444492116856810, 2119298990],
      [[42, 7, 2, 17, 3], 1010681648012686, 481930564],
      [[0xffffffff, 16, 4, 1_000_000, 9, 1, 2, 3], 3921018777816483, 1869687451],
      [[123456789, 8, 0, 0, 0, 0, 0, 1], 1057452570144380, 504232678],
    ];
    for (const [w, bits, word] of golden) {
      expect(draw(w) * 2 ** 53).toBe(bits);
      expect(u32(w[0]!, src(w[1]!), w[2], w[3], w[4], w[5], w[6], w[7])).toBe(word);
    }
  });

  it('matches the plain reference construction on random inputs', () => {
    const next = xorshift(0x9e3779b9);
    const w = new Array<number>(8);
    for (let n = 0; n < 20_000; n++) {
      // Mix full 32-bit words with small keys, the common case.
      for (let i = 0; i < 8; i++) w[i] = n % 3 === 0 ? next() : next() & 0x3ff;
      expect(draw(w)).toBe(reference(w));
    }
  });

  it('gives the same value for the same key, in any order', () => {
    const keys: [number, number][] = [];
    for (let session = 0; session < 50; session++) {
      for (let turn = 0; turn < 20; turn++) keys.push([session, turn]);
    }
    const forward = new Map<string, number>();
    for (const [s, t] of keys) forward.set(`${s}/${t}`, u01(7, Source.thinkTime, 1, s, t));

    // Ask in another order, with unrelated draws interleaved: nothing carries between draws.
    const next = xorshift(12345);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    for (const [s, t] of keys) {
      u01(7, Source.outputLength, 1, s, t);
      expect(u01(7, Source.thinkTime, 1, s, t)).toBe(forward.get(`${s}/${t}`));
    }
  });

  it('treats omitted keys as 0 and reads every argument as a 32-bit integer', () => {
    expect(u01(3, Source.turns, 5)).toBe(u01(3, Source.turns, 5, 0, 0, 0, 0, 0));
    expect(u01(3, Source.turns)).toBe(u01(3, Source.turns, 0));
    expect(u01(3, Source.turns, 2 ** 32 + 5)).toBe(u01(3, Source.turns, 5));
    expect(u01(3, Source.turns, -1)).toBe(u01(3, Source.turns, 0xffffffff));
    expect(u01(2 ** 32 + 3, Source.turns, 5)).toBe(u01(3, Source.turns, 5));
    // Order matters: keys are positional.
    expect(u01(3, Source.turns, 5, 0)).not.toBe(u01(3, Source.turns, 0, 5));
  });

  it('returns multiples of 2^-53 in [0, 1), with u32 the top 32 of those bits', () => {
    for (let i = 0; i < 10_000; i++) {
      const u = u01(11, Source.messageLength, 0, i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const bits = u * 2 ** 53;
      expect(Number.isInteger(bits)).toBe(true);
      const word = u32(11, Source.messageLength, 0, i);
      expect(word).toBe(Math.floor(bits / 2 ** 21));
      expect(word).toBeLessThan(2 ** 32);
    }
  });

  it('never collides for keys that differ in one word', () => {
    for (let pos = 0; pos < 8; pos++) {
      const w = [17, 5, 1, 2, 3, 4, 5, 6];
      const seen = new Set<number>();
      for (let i = 0; i < N; i++) {
        w[pos] = i;
        seen.add(draw(w));
      }
      expect(seen.size).toBe(N);
    }
  });
});

describe('keyed draws: independence', () => {
  const base = [2026, 7, 3, 41, 2, 9, 0, 0];

  it('draws that differ in one key word are uncorrelated', () => {
    // For each word: pair i with i + 1 (neighbouring sessions or turns) and i with i + 2^16.
    for (let pos = 0; pos < 8; pos++) {
      for (const delta of [1, 65_536]) {
        const x = new Float64Array(N);
        const y = new Float64Array(N);
        const w = base.slice();
        for (let i = 0; i < N; i++) {
          w[pos] = i;
          x[i] = draw(w);
          w[pos] = i + delta;
          y[i] = draw(w);
        }
        expect(Math.abs(correlation(x, y)), `word ${pos}, delta ${delta}`).toBeLessThan(CORR_TOL);
      }
    }
  });

  it('different sources, seeds, and key positions give uncorrelated streams', () => {
    const pairs: [string, (i: number) => number, (i: number) => number][] = [
      [
        'sources',
        (i) => u01(1, Source.messageLength, 0, i),
        (i) => u01(1, Source.outputLength, 0, i),
      ],
      ['seeds', (i) => u01(1, Source.thinkTime, 0, i), (i) => u01(2, Source.thinkTime, 0, i)],
      ['positions', (i) => u01(1, Source.turns, i, 0), (i) => u01(1, Source.turns, 0, i)],
      ['days', (i) => u01(1, Source.turns, 0, i), (i) => u01(1, Source.turns, 1, i)],
    ];
    for (const [name, f, g] of pairs) {
      const x = new Float64Array(N);
      const y = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        x[i] = f(i);
        y[i] = g(i);
      }
      expect(Math.abs(correlation(x, y)), name).toBeLessThan(CORR_TOL);
    }
  });

  it('has no bias in any of the 53 bits, low bits included', () => {
    const ones = new Float64Array(53);
    let sameLowBit = 0;
    let prevLow = -1;
    for (let i = 0; i < N; i++) {
      const bits = u01(5, Source.retryJitter, 1, i, 0) * 2 ** 53;
      const hi = Math.floor(bits / 2 ** 26);
      const lo = bits - hi * 2 ** 26;
      for (let b = 0; b < 26; b++) ones[b]! += (lo >>> b) & 1;
      for (let b = 0; b < 27; b++) ones[26 + b]! += (hi >>> b) & 1;
      const low = lo & 1;
      if (low === prevLow) sameLowBit++;
      prevLow = low;
    }
    // Each bit is set half the time (5 standard errors), and the lowest bit doesn't repeat or
    // alternate between neighbouring keys.
    const tol = 5 * (0.5 / Math.sqrt(N));
    for (let b = 0; b < 53; b++) expect(Math.abs(ones[b]! / N - 0.5), `bit ${b}`).toBeLessThan(tol);
    expect(Math.abs(sameLowBit / (N - 1) - 0.5)).toBeLessThan(tol);
  });

  it('avalanches: flipping one input bit flips each output bit about half the time', () => {
    const next = xorshift(2024);
    const samples = 2_000;
    const w = new Array<number>(8);
    let worst = 0;
    for (let pos = 0; pos < 8; pos++) {
      for (const bit of [0, 1, 5, 12, 20, 31]) {
        const flips = new Float64Array(53);
        for (let s = 0; s < samples; s++) {
          for (let i = 0; i < 8; i++) w[i] = next() & 0xffff;
          const x = draw(w) * 2 ** 53;
          w[pos] = w[pos]! ^ (1 << bit);
          const y = draw(w) * 2 ** 53;
          const dHi = Math.floor(x / 2 ** 26) ^ Math.floor(y / 2 ** 26);
          const dLo = (x % 2 ** 26) ^ (y % 2 ** 26);
          for (let b = 0; b < 26; b++) flips[b]! += (dLo >>> b) & 1;
          for (let b = 0; b < 27; b++) flips[26 + b]! += (dHi >>> b) & 1;
        }
        for (let b = 0; b < 53; b++) worst = Math.max(worst, Math.abs(flips[b]! / samples - 0.5));
      }
    }
    // 2,544 cells, standard error 0.011 each: the largest deviation of pure noise is about 0.045.
    expect(worst).toBeLessThan(0.06);
  });
});
