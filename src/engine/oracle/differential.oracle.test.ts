// The differential oracle (E10, 00-build §7.2): over N seeded workloads, the engine (shared, a
// scripted client, E7's router, E5 with event-jumping, E9's metrics) and the oracle's plain
// step-by-step simulator agree on every request's first-token and finish times (≤ 1e-6
// relative), outcome, replica, preemptions, cached tokens, output done, and state sequence, and
// on every replica meter. 200 seeds in `pnpm test`; ORACLE_SEEDS sets the count
// (`pnpm test:oracle:long` runs 5,000) and ORACLE_SEED runs one seed. A failure prints the seed,
// the request, and the first diverging event and step.

import { describe, expect, it } from 'vitest';
import raw from '../../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../calibration.ts';
import { TOPIC } from '../core/index.ts';
import { createReplicaModule } from '../replica/index.ts';
import { OUTCOME } from '../results.ts';
import { checkInput, checkSeed, explain } from './differential.ts';
import { oracleWorkload } from './workload.ts';

const cal = parseCalibration(raw);
const one = process.env.ORACLE_SEED === undefined ? null : Number(process.env.ORACLE_SEED);
const SEEDS = one ?? Number(process.env.ORACLE_SEEDS ?? 200);
const FIRST = one ?? 1;
const BATCH = 25;
/** Seeds that also check every module's invariants after every event (slow). */
const ASSERT_EVERY_EVENT = 5;

describe('engine vs oracle', () => {
  const totals = {
    seeds: 0,
    requests: 0,
    twoReplicas: 0,
    kvUtilization: 0,
    production: 0,
    simultaneous: 0,
    finished: 0,
    preempted: 0,
    cached: 0,
    timedOut: 0,
    failed: 0,
    rejected: 0,
    maxRequests: 0,
  };

  for (let from = FIRST; from <= SEEDS; from += BATCH) {
    const to = Math.min(SEEDS, from + BATCH - 1);
    it(`agrees on every request, seeds ${from}-${to}`, { timeout: 600_000 }, () => {
      const failed: number[] = [];
      let report = '';
      for (let seed = from; seed <= to; seed++) {
        const check = checkSeed(seed, cal, { assertEveryEvent: seed <= ASSERT_EVERY_EVENT });
        const { input, oracle } = check;
        const r = oracle.requests;
        totals.seeds++;
        totals.requests += input.requests.length;
        totals.maxRequests = Math.max(totals.maxRequests, input.requests.length);
        if (input.cal.engine.kvPoolTokens === cal.engine.kvPoolTokens) totals.production++;
        const starts = input.requests.filter((q) => q.after === undefined).map((q) => q.atMs);
        if (new Set(starts).size < starts.length) totals.simultaneous++;
        if (input.config.replicas === 2) {
          totals.twoReplicas++;
          if (input.config.tunable.routingPolicy === 'kvUtilization') totals.kvUtilization++;
        }
        totals.finished += r.outcome.filter((o) => o === OUTCOME.finished).length;
        totals.preempted += r.preemptions.filter((p) => p > 0).length;
        totals.cached += r.cachedTokens.filter((c) => c > 0).length;
        totals.timedOut += r.outcome.filter((o) => o === OUTCOME.timedOut).length;
        totals.failed += r.outcome.filter((o) => o === OUTCOME.failed).length;
        totals.rejected += r.outcome.filter((o) => o === OUTCOME.rejected).length;
        expect(r.outcome.includes(-1), `seed ${seed}: the oracle left a request unended`).toBe(
          false,
        );
        if (check.mismatches.length > 0) {
          if (failed.length === 0) report = explain(check);
          failed.push(seed);
        }
      }
      if (failed.length > 0) {
        const others =
          failed.length > 1 ? `\nOther failing seeds: ${failed.slice(1).join(', ')}` : '';
        throw new Error(`${report}${others}`);
      }
    });
  }

  it('the workloads exercise every path', () => {
    console.info('E10 oracle', totals);
    if (one !== null) return;
    const n = totals.seeds;
    expect(totals.maxRequests).toBeLessThanOrEqual(300);
    expect(totals.twoReplicas).toBeGreaterThan(n * 0.35);
    expect(totals.kvUtilization).toBeGreaterThan(n * 0.12);
    expect(totals.production).toBeGreaterThan(n * 0.05);
    expect(totals.simultaneous).toBeGreaterThan(n * 0.05);
    expect(totals.preempted).toBeGreaterThan(n);
    expect(totals.cached).toBeGreaterThan(n * 10);
    expect(totals.timedOut).toBeGreaterThan(n / 2);
    expect(totals.failed).toBeGreaterThan(n / 10);
    expect(totals.rejected).toBeGreaterThan(n / 10);
  });
});

describe('the oracle catches a known regression', () => {
  // The router samples each replica's KV level at a signal refresh. Inside a decode span E5 applies
  // block allocations lazily, so the router sends meterSync first. A replica that ignores it lets
  // kvUtilization route on a stale level; the oracle, which has no lazy state, must notice.
  it('a replica that ignores meterSync', { timeout: 120_000 }, () => {
    const base = createReplicaModule();
    const replicaModule = {
      ...base,
      notices: base.notices!.filter((n) => n.topic !== TOPIC.meterSync),
    };
    let tried = 0;
    let caught = 0;
    for (let seed = 1; tried < 40 && caught < 3; seed++) {
      const input = oracleWorkload(seed, cal);
      if (input.config.replicas !== 2 || input.config.tunable.routingPolicy !== 'kvUtilization') {
        continue;
      }
      tried++;
      if (checkInput(input, { replicaModule }).mismatches.length > 0) caught++;
    }
    expect(caught).toBeGreaterThan(0);
  });
});
