// Each policy's choice on hand-built router views (02 §7).

import { describe, expect, it } from 'vitest';
import {
  affinityTarget,
  buildRing,
  chooseReplica,
  routableSet,
  sessionHash,
  weightedScore,
  type RoutingParams,
  type RoutingView,
} from './index.ts';

function view(
  routable: number[],
  seenOutstanding: number[],
  seenKv: number[] = seenOutstanding.map(() => 0),
  rrLast = -1,
): RoutingView {
  const n = seenOutstanding.length;
  return {
    ...routableSet(n, routable),
    ring: buildRing(3, n, 32),
    seenOutstanding: Float64Array.from(seenOutstanding),
    seenKv: Float64Array.from(seenKv),
    rrLast,
  };
}

function params(overrides: Partial<RoutingParams>): RoutingParams {
  return {
    routingPolicy: 'roundRobin',
    hashScheme: 'modN',
    weightAffinity: 1,
    weightOutstanding: 1,
    weightKv: 1,
    ...overrides,
  };
}

describe('round-robin', () => {
  it('cycles through routable replicas in id order, skipping the rest', () => {
    const v = view([0, 1, 3], [9, 9, 9, 9]);
    const p = params({ routingPolicy: 'roundRobin' });
    const picks: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = chooseReplica(v, p, 0, 0);
      picks.push(r);
      v.rrLast = r;
    }
    expect(picks).toEqual([0, 1, 3, 0, 1, 3]);
  });

  it('continues after the last pick when the set changes', () => {
    const p = params({ routingPolicy: 'roundRobin' });
    expect(chooseReplica(view([0, 1, 2, 3], [0, 0, 0, 0], undefined, 1), p, 0, 0)).toBe(2);
    expect(chooseReplica(view([0, 1, 3], [0, 0, 0, 0], undefined, 1), p, 0, 0)).toBe(3);
    expect(chooseReplica(view([0, 1], [0, 0, 0, 0], undefined, 3), p, 0, 0)).toBe(0);
  });
});

describe('least-outstanding', () => {
  const p = params({ routingPolicy: 'leastOutstanding' });

  it('picks the smallest sampled count among routable replicas', () => {
    expect(chooseReplica(view([0, 1, 2, 3], [4, 2, 7, 3]), p, 0, 0.99)).toBe(1);
    // Replica 1 looks idlest but is not routable.
    expect(chooseReplica(view([0, 2, 3], [4, 0, 7, 3]), p, 0, 0.5)).toBe(3);
  });

  it('breaks ties uniformly with the keyed uniform, in id order', () => {
    const v = view([0, 1, 2, 3], [5, 1, 9, 1]);
    expect(chooseReplica(v, p, 0, 0)).toBe(1);
    expect(chooseReplica(v, p, 0, 0.49)).toBe(1);
    expect(chooseReplica(v, p, 0, 0.5)).toBe(3);
    expect(chooseReplica(v, p, 0, 0.999)).toBe(3);
  });
});

describe('KV utilization', () => {
  const p = params({ routingPolicy: 'kvUtilization' });

  it('picks the lowest sampled KV fraction, ignoring request counts', () => {
    expect(chooseReplica(view([0, 1, 2], [0, 9, 9], [0.9, 0.2, 0.5]), p, 0, 0)).toBe(1);
    expect(chooseReplica(view([0, 2], [0, 9, 9], [0.9, 0.2, 0.5]), p, 0, 0)).toBe(2);
  });

  it('breaks ties with the keyed uniform', () => {
    const v = view([0, 1, 2], [0, 0, 0], [0.3, 0.3, 0.3]);
    expect([0, 0.4, 0.8].map((u) => chooseReplica(v, p, 0, u))).toEqual([0, 1, 2]);
  });
});

describe('session affinity', () => {
  it('sends a session to its hash target, whatever the load (blind to load and eviction)', () => {
    for (const hashScheme of ['modN', 'consistent'] as const) {
      const p = params({ routingPolicy: 'sessionAffinity', hashScheme });
      const v = view([0, 1, 2, 3], [0, 0, 0, 0]);
      for (let s = 0; s < 50; s++) {
        const h = sessionHash(1, 2, s);
        const target = affinityTarget(v, v.ring, hashScheme, h);
        v.seenOutstanding.fill(0);
        v.seenOutstanding[target] = 1_000;
        v.seenKv[target] = 1;
        expect(chooseReplica(v, p, h, 0.5)).toBe(target);
      }
    }
  });

  it('mod-N uses hash mod the routable count', () => {
    const p = params({ routingPolicy: 'sessionAffinity', hashScheme: 'modN' });
    expect(chooseReplica(view([0, 1, 2, 3], [0, 0, 0, 0]), p, 10, 0)).toBe(2);
    expect(chooseReplica(view([0, 1, 3], [0, 0, 0, 0]), p, 10, 0)).toBe(1);
  });
});

describe('weighted scoring', () => {
  // Replica 2 is the affinity target of hash 2 under mod-N with all four routable.
  const v = view([0, 1, 2, 3], [4, 2, 8, 6], [0.5, 0.9, 0.2, 0.1]);

  it('scores affinity minus normalized outstanding minus KV fraction', () => {
    const p = params({ routingPolicy: 'weighted', weightAffinity: 2, weightOutstanding: 1 });
    expect(weightedScore(v, p, 2, 2, 8)).toBeCloseTo(2 - 1 - 0.2, 12);
    expect(weightedScore(v, p, 0, 2, 8)).toBeCloseTo(-0.5 - 0.5, 12);
    expect(chooseReplica(v, p, 2, 0)).toBe(2); // 0.8 beats 3's -0.85, 0's -1, 1's -1.15
  });

  it('reduces to affinity, least-outstanding, or KV with one nonzero weight', () => {
    const only = (a: number, o: number, k: number) =>
      chooseReplica(
        v,
        params({ routingPolicy: 'weighted', weightAffinity: a, weightOutstanding: o, weightKv: k }),
        2,
        0,
      );
    expect(only(1, 0, 0)).toBe(2);
    expect(only(0, 1, 0)).toBe(1);
    expect(only(0, 0, 1)).toBe(3);
  });

  it('trades locality for balance as the outstanding weight grows', () => {
    const p = (weightOutstanding: number) =>
      params({ routingPolicy: 'weighted', weightAffinity: 1, weightOutstanding, weightKv: 0 });
    // Target 2 is the busiest (normalized 1); replica 1 is at 2/8 = 0.25.
    expect(chooseReplica(v, p(1.3), 2, 0)).toBe(2); // 1 - 1.3 = -0.3 > -0.325
    expect(chooseReplica(v, p(1.4), 2, 0)).toBe(1); // -0.4 < -0.35
  });

  it('treats an all-idle fleet as zero load and breaks ties with the keyed uniform', () => {
    const idle = view([0, 1, 2], [0, 0, 0]);
    const p = params({ routingPolicy: 'weighted', weightAffinity: 0 });
    expect([0, 0.34, 0.9].map((u) => chooseReplica(idle, p, 0, u))).toEqual([0, 1, 2]);
  });
});

describe('no routable replica', () => {
  it('returns -1 under every policy', () => {
    const v = view([], [0, 0]);
    for (const routingPolicy of [
      'roundRobin',
      'leastOutstanding',
      'sessionAffinity',
      'kvUtilization',
      'weighted',
    ] as const) {
      expect(chooseReplica(v, params({ routingPolicy }), 5, 0.5)).toBe(-1);
    }
  });
});
