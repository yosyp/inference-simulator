import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { Source, logLogistic, lognormal, u01 } from './index.ts';

// A quick micro-benchmark, not a budget. It logs draws per second so a regression is visible; see
// the numbers with `pnpm test src/engine/rng/bench --reporter=verbose`. The floor is far below the
// expected rate (over ten million per second) and only catches something pathological, such as an
// allocation or a deoptimization on every draw.

const DRAWS = 1_000_000;
const FLOOR_PER_S = 500_000;

/** Draws per second for a loop of DRAWS draws. Each loop has its own call site, so none is shared. */
function perSecond(loop: (n: number) => number): number {
  loop(50_000); // warm-up
  const t0 = performance.now();
  const sink = loop(DRAWS);
  const seconds = (performance.now() - t0) / 1000;
  expect(Number.isFinite(sink)).toBe(true);
  return DRAWS / seconds;
}

describe('rng throughput', () => {
  it('logs keyed draws per second', () => {
    const rates = {
      u01: perSecond((n) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += u01(1, Source.messageLength, 2, i >>> 4, i & 15);
        return s;
      }),
      lognormal: perSecond((n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          s += lognormal(u01(1, Source.outputLength, 2, i >>> 4, i & 15), 300, 0.7);
        }
        return s;
      }),
      logLogistic: perSecond((n) => {
        let s = 0;
        for (let i = 0; i < n; i++) {
          s += logLogistic(u01(1, Source.thinkTime, 2, i >>> 4, i & 15), 90_000, 2);
        }
        return s;
      }),
    };
    const line = Object.entries(rates)
      .map(([name, r]) => `${name} ${(r / 1e6).toFixed(1)}M/s`)
      .join(', ');
    console.log(`rng draws per second: ${line}`);
    for (const r of Object.values(rates)) expect(r).toBeGreaterThan(FLOOR_PER_S);
  });
});
