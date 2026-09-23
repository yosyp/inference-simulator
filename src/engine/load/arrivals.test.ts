import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, dayStartMs } from '../time.ts';
import { MAX_LOAD_MULTIPLIER, advanceCursor, buildEnvelope, createCursor } from './arrivals.ts';
import { sessionPlan } from './plan.ts';
import { TEST_DAY, fixedService, runner, testConfig, testInput } from './testkit.ts';

const START = dayStartMs(TEST_DAY);

/** ∫ of the piecewise-linear knots over [a, b) (time of day), by fine midpoint sums. */
function diurnalIntegral(
  knots: readonly (readonly [number, number])[],
  a: number,
  b: number,
): number {
  const w = (t: number) => {
    for (let k = 0; k + 1 < knots.length; k++) {
      const [ta, wa] = knots[k]!;
      const [tb, wb] = knots[k + 1]!;
      if (t >= ta && t < tb) return wa + ((wb - wa) * (t - ta)) / (tb - ta);
    }
    return 0;
  };
  const steps = 20_000;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += w(a + ((i + 0.5) * (b - a)) / steps);
  return (sum * (b - a)) / steps;
}

describe('arrival envelope', () => {
  it('covers the knots inside the shift in short segments, scaled to the expected sessions', () => {
    const cfg = testConfig({ shift: { startMs: 9 * HOUR_MS, endMs: 17 * HOUR_MS } });
    const env = buildEnvelope(cfg, TEST_DAY);
    const n = env.segStart.length;
    expect(env.segStart[0]).toBe(START + 9 * HOUR_MS);
    expect(env.segEnd[n - 1]).toBe(START + 12 * HOUR_MS);
    for (let j = 0; j < n; j++) {
      expect(env.segEnd[j]! - env.segStart[j]!).toBeLessThanOrEqual(15 * MINUTE_MS);
      if (j > 0) expect(env.segStart[j]).toBe(env.segEnd[j - 1]);
      expect(env.hazard[j + 1]).toBeGreaterThanOrEqual(env.hazard[j]!);
    }
    expect(env.expectedSessions).toBe(20 * 3);
    // The envelope bounds the intensity at MAX_LOAD_MULTIPLIER, but not by much.
    const ratio = env.hazard[n]! / (env.expectedSessions * MAX_LOAD_MULTIPLIER);
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(ratio).toBeLessThan(1.1);
  });

  it('has no candidates when there is nothing to start', () => {
    for (const cfg of [
      testConfig({ analystsPerReplica: 0 }),
      testConfig({ diurnal: { knots: [[8 * HOUR_MS, 1]], dayMultipliers: [1, 1, 1, 1, 1] } }),
      testConfig({
        diurnal: {
          knots: [
            [8 * HOUR_MS, 1],
            [9 * HOUR_MS, 1],
          ],
          dayMultipliers: [1, 1, 0, 1, 1],
        },
      }),
    ]) {
      const env = buildEnvelope(cfg, TEST_DAY);
      expect(advanceCursor(env, 1, TEST_DAY, createCursor())).toBe(false);
      expect(sessionPlan(testInput(cfg))).toEqual([]);
    }
  });

  it('rejects configs it cannot honour', () => {
    expect(() => buildEnvelope(testConfig({ shift: { startMs: 5, endMs: 5 } }), TEST_DAY)).toThrow(
      RangeError,
    );
    const unsorted = {
      knots: [
        [9 * HOUR_MS, 1],
        [8 * HOUR_MS, 1],
      ] as const,
      dayMultipliers: [1, 1, 1, 1, 1] as const,
    };
    expect(() => buildEnvelope(testConfig({ diurnal: unsorted }), TEST_DAY)).toThrow(RangeError);
    expect(() => buildEnvelope(testConfig({ thinkTimeShape: 0 }), TEST_DAY)).toThrow(RangeError);
  });
});

describe('session starts', () => {
  it('match analysts × sessions per analyst × day multiplier over many seeds (simulated)', () => {
    const run = runner(fixedService(1_000), false);
    for (const [loadMultiplier, dayMult] of [
      [1, 1],
      [2, 0.5],
    ] as const) {
      const cfg0 = testConfig({}, { loadMultiplier });
      const expected = 60 * loadMultiplier * dayMult;
      let total = 0;
      const seeds = 150;
      for (let seed = 1; seed <= seeds; seed++) {
        const cfg = {
          ...cfg0,
          seed,
          diurnal: { ...cfg0.diurnal, dayMultipliers: [1, 1, dayMult, 1, 1] as const },
        };
        const r = run.createDayRun(testInput(cfg));
        r.advance(r.dayEndMs);
        total += r.state.load.stats.sessions;
      }
      const sd = Math.sqrt(expected / seeds);
      expect(Math.abs(total / seeds - expected)).toBeLessThan(4 * sd);
    }
  });

  it('follow the diurnal curve, cut to the shift', () => {
    const knots = [
      [6 * HOUR_MS, 0.2],
      [8 * HOUR_MS, 1],
      [11 * HOUR_MS, 0.4],
      [14 * HOUR_MS, 0.8],
      [19 * HOUR_MS, 0],
    ] as const;
    const cfg0 = testConfig({
      analystsPerReplica: 500,
      diurnal: { knots, dayMultipliers: [1, 1, 1, 1, 1] },
    });
    const shift = cfg0.shift;
    const hours = (shift.endMs - shift.startMs) / HOUR_MS;
    const counts = new Array<number>(hours).fill(0);
    const seeds = 10;
    let total = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      for (const s of sessionPlan(testInput({ ...cfg0, seed }))) {
        const tod = s.startMs - START;
        expect(tod).toBeGreaterThanOrEqual(shift.startMs);
        expect(tod).toBeLessThan(shift.endMs);
        counts[Math.floor((tod - shift.startMs) / HOUR_MS)]!++;
        total++;
      }
    }
    const perDay = 1_000 * 3;
    expect(Math.abs(total / seeds - perDay)).toBeLessThan(4 * Math.sqrt(perDay / seeds));
    const area = diurnalIntegral(knots, shift.startMs, shift.endMs);
    for (let h = 0; h < hours; h++) {
      const a = shift.startMs + h * HOUR_MS;
      const expected = (seeds * perDay * diurnalIntegral(knots, a, a + HOUR_MS)) / area;
      expect(Math.abs(counts[h]! - expected)).toBeLessThan(4 * Math.sqrt(expected) + 1);
    }
  });

  it('a higher multiplier only adds sessions; the shared ones are unchanged', () => {
    const base = sessionPlan(testInput(testConfig({ analystsPerReplica: 50 })));
    const more = sessionPlan(
      testInput(testConfig({ analystsPerReplica: 50 }, { loadMultiplier: 1.7 })),
    );
    expect(more.length).toBeGreaterThan(base.length * 1.4);
    const byId = new Map(more.map((s) => [s.session, s]));
    for (const s of base) expect(byId.get(s.session)).toEqual(s);
  });

  it('clamps the multiplier to MAX_LOAD_MULTIPLIER', () => {
    const at = (m: number) => sessionPlan(testInput(testConfig({}, { loadMultiplier: m })));
    expect(at(MAX_LOAD_MULTIPLIER * 3)).toEqual(at(MAX_LOAD_MULTIPLIER));
    expect(at(0)).toEqual([]);
    expect(at(-1)).toEqual([]);
  });
});
