// Metrics slice invariants (00-build §7.1). O(replicas), so tests can run them after every event.

import type { Ctx, DayState } from '../core/types.ts';
import { HISTOGRAM_METRICS, HISTOGRAM_SPECS } from '../histogram.ts';
import { REPLICA_COUNTERS } from '../shared/meters.ts';
import { histCapacity, scalarCapacity } from './pending.ts';
import { METRIC_COUNT, METRIC_INDEX as MI } from './slice.ts';

const FLEET_ONLY = [
  MI.offered,
  MI.organic,
  MI.rejected,
  MI.retries,
  MI.abandonedSessions,
  MI.readyReplicas,
];

export function assertMetrics(state: DayState, ctx: Ctx): void {
  const s = state.metrics;
  const c = state.core;
  const { bucketMs, histBucketMs, replicas } = ctx.input.config;
  const fail = (msg: string): never => {
    throw new Error(`Metrics invariant (day ${c.day}, now ${c.nowMs}): ${msg}`);
  };
  const S = replicas + 1;

  // Accumulators are sized for the replicas.
  if (s.replicas !== replicas) fail(`slice has ${s.replicas} replicas, config ${replicas}`);
  if (s.open.length !== METRIC_COUNT * S) fail('open scalar bucket is mis-sized');
  for (const m of HISTOGRAM_METRICS) {
    if (s.openHist[m].length !== S * HISTOGRAM_SPECS[m].bins)
      fail(`open ${m} histogram is mis-sized`);
  }
  if (s.prevCounters.length !== REPLICA_COUNTERS.length * replicas) fail('prevCounters mis-sized');
  for (const a of [s.ready, s.readyKvArea, s.readyMs, s.markMs, s.markArea, s.served]) {
    if (a.length !== replicas) fail('a per-replica array is mis-sized');
  }
  if (s.servedE2eMs.length !== replicas || s.busyInShiftMs.length !== replicas) {
    fail('rollup totals mis-sized');
  }
  if (s.scalars.series !== S || s.hists.series !== S) fail('pending blocks have the wrong series');

  // Bucket starts are aligned, and pending buckets run contiguously up to the open ones.
  if (s.bucketStartMs !== c.closedToMs) fail(`open bucket ${s.bucketStartMs} != ${c.closedToMs}`);
  if ((s.bucketStartMs - c.dayStartMs) % bucketMs !== 0) fail('open bucket is misaligned');
  if (s.histStartMs !== Math.floor(s.bucketStartMs / histBucketMs) * histBucketMs) {
    fail(`open histogram bucket ${s.histStartMs} is misaligned`);
  }
  if (s.scalars.startMs + s.scalars.count * bucketMs !== s.bucketStartMs) {
    fail('pending scalar buckets do not end at the open bucket');
  }
  if (s.hists.startMs + s.hists.count * histBucketMs !== s.histStartMs) {
    fail('pending histogram buckets do not end at the open histogram bucket');
  }
  if (s.scalars.count > scalarCapacity(s.scalars) || s.hists.count > histCapacity(s.hists)) {
    fail('pending bucket count exceeds capacity');
  }
  if (s.requests.count > s.requests.id.length || s.transitions.count > s.transitions.atMs.length) {
    fail('pending record count exceeds capacity');
  }

  // Nothing pending predates the last chunk, so no row is emitted twice.
  const tr = s.transitions;
  if (tr.count > 0 && !(tr.atMs[0]! >= s.emittedToMs && tr.atMs[tr.count - 1]! <= c.nowMs)) {
    fail('pending transitions fall outside [last chunk end, now]');
  }
  const ev = s.replicaEvents;
  if (ev.length > 0 && !(ev[0]!.atMs >= s.emittedToMs && ev[ev.length - 1]!.atMs <= c.nowMs)) {
    fail('pending replica events fall outside [last chunk end, now]');
  }

  // Replica series of fleet-only metrics stay zero; the Ready count matches the flags.
  for (const m of FLEET_ONLY) {
    for (let r = 1; r < S; r++)
      if (s.open[m * S + r] !== 0) fail('a fleet-only metric has a replica value');
  }
  let ready = 0;
  for (let r = 0; r < replicas; r++) ready += s.ready[r]!;
  if (s.readyCount.value !== ready) fail(`ready level ${s.readyCount.value} != ${ready} flags`);

  // Request conservation: arrived = finished + rejected + timed out + failed + in flight.
  const t = state.shared.requests;
  const d = s.day;
  const inFlight = t.liveCount - t.pendingFree.length;
  if (d.arrived - d.finished - d.rejected - d.timedOut - d.failed !== inFlight) {
    fail(
      `arrived ${d.arrived} - ended ${d.finished + d.rejected + d.timedOut + d.failed} != in flight ${inFlight}`,
    );
  }
}
