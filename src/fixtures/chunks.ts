// Contract-shaped ResultChunks from synthetic signals, for engine-client tests (U2) before the engine lands.

import { HISTOGRAM_SPECS, binIndex } from '../engine/histogram.ts';
import {
  FLEET_SERIES,
  OUTCOME,
  REPLICA_STATE,
  REQUEST_STATE,
  allocHistogramBlock,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  replicaSeries,
  type ReplicaEvent,
  type ResultChunk,
} from '../engine/results.ts';
import { dayOf, type SimMs } from '../engine/time.ts';
import { hash01, normal, replicaPhase, signals, type FixtureOptions } from './synthetic.ts';

export const FIXTURE_BUCKET_MS = 10_000;
export const FIXTURE_HIST_BUCKET_MS = 60_000;
/** The fixture's tracked analyst sends one request every 3 minutes during the shift. */
export const FIXTURE_TRACKED_ANALYST = 7;
const TRACKED_PERIOD_MS = 180_000;

function phaseCode(phase: ReturnType<typeof replicaPhase>['phase']) {
  return REPLICA_STATE[phase];
}

/** One chunk covering [fromMs, toMs); both must be multiples of FIXTURE_HIST_BUCKET_MS within one day. */
export function makeFixtureChunk(opts: FixtureOptions, fromMs: SimMs, toMs: SimMs): ResultChunk {
  const day = dayOf(fromMs);
  const series = opts.replicas + 1;
  const nScalar = (toMs - fromMs) / FIXTURE_BUCKET_MS;
  const nHist = (toMs - fromMs) / FIXTURE_HIST_BUCKET_MS;
  const scalars = allocScalarBlock(fromMs, FIXTURE_BUCKET_MS, nScalar, series);
  const histograms = allocHistogramBlock(fromMs, FIXTURE_HIST_BUCKET_MS, nHist, series);
  const d = scalars.data;
  const bucketS = FIXTURE_BUCKET_MS / 1000;

  for (let b = 0; b < nScalar; b++) {
    const t = fromMs + (b + 0.5) * FIXTURE_BUCKET_MS;
    const f = b * series + FLEET_SERIES;
    let ready = 0;
    for (let r = 0; r < opts.replicas; r++) {
      const s = signals(opts, r, t);
      const i = b * series + replicaSeries(r);
      const served = (s.requestsPerMin * bucketS) / 60;
      if (replicaPhase(opts, r, t).phase === 'ready') ready++;
      d.kvUsedFrac[i] = s.kvUsedFrac;
      d.kvUsedFracMax[i] = Math.min(1, s.kvUsedFrac * 1.02);
      d.running[i] = s.running;
      d.waiting[i] = s.waiting;
      d.outstanding[i] = s.running + s.waiting;
      d.preemptions[i] = (s.preemptionsPerMin * bucketS) / 60;
      d.decodeTokens[i] = served * 300;
      d.prefillTokens[i] = served * 1200;
      d.prefixQueryTokens[i] = served * 2000;
      d.prefixHitTokens[i] = served * 800;
      d.busyMs[i] = s.nvidiaSmiUtil * FIXTURE_BUCKET_MS;
      d.flops[i] = s.computeUtil * 312e12 * bucketS;
      d.dispatched[i] = served;
      d.finished[i] = served;
      d.ttftSumMs[i] = served * s.ttftMedianMs * 1.3;
      d.ttftCount[i] = served;
      d.e2eSumMs[i] = served * (s.ttftMedianMs * 1.3 + 300 * s.tpotMedianMs);
      d.e2eCount[i] = served;
      d.tpotSumMs[i] = served * s.tpotMedianMs;
      d.tpotCount[i] = served;
      for (const m of [
        'running',
        'waiting',
        'outstanding',
        'preemptions',
        'decodeTokens',
        'prefillTokens',
        'prefixQueryTokens',
        'prefixHitTokens',
        'busyMs',
        'flops',
        'dispatched',
        'finished',
        'ttftSumMs',
        'ttftCount',
        'e2eSumMs',
        'e2eCount',
        'tpotSumMs',
        'tpotCount',
      ] as const) {
        d[m][f]! += d[m][i]!;
      }
      d.kvUsedFrac[f]! += s.kvUsedFrac / opts.replicas;
      d.kvUsedFracMax[f] = Math.max(d.kvUsedFracMax[f]!, d.kvUsedFracMax[i]!);
    }
    d.readyReplicas[f] = ready;
    d.organic[f] = d.dispatched[f]!;
    d.offered[f] = d.dispatched[f]!;
  }

  for (let b = 0; b < nHist; b++) {
    const t = fromMs + (b + 0.5) * FIXTURE_HIST_BUCKET_MS;
    for (let r = 0; r < opts.replicas; r++) {
      const s = signals(opts, r, t);
      const n = Math.round(s.requestsPerMin);
      for (const [metric, median, sigma] of [
        ['ttft', s.ttftMedianMs, 0.7],
        ['tpot', s.tpotMedianMs, 0.15],
        ['e2e', s.ttftMedianMs + 300 * s.tpotMedianMs, 0.6],
      ] as const) {
        const bins = HISTOGRAM_SPECS[metric].bins;
        for (let k = 0; k < n; k++) {
          const v = median * Math.exp(sigma * normal(b * 1000 + k, r * 7 + bins));
          const bin = binIndex(HISTOGRAM_SPECS[metric], v);
          histograms.data[metric][(b * series + replicaSeries(r)) * bins + bin]! += 1;
          histograms.data[metric][(b * series + FLEET_SERIES) * bins + bin]! += 1;
        }
      }
    }
  }

  // The tracked analyst's requests that finish in this chunk, with their transitions.
  const trackedStarts: number[] = [];
  const first = Math.ceil(fromMs / TRACKED_PERIOD_MS) * TRACKED_PERIOD_MS;
  for (let t = first; t < toMs; t += TRACKED_PERIOD_MS) {
    if (signals(opts, 0, t).requestsPerMin > 0) trackedStarts.push(t);
  }
  const requests = allocRequestBlock('tracked', trackedStarts.length);
  const transitions = allocTransitionBlock('tracked', trackedStarts.length * 4);
  trackedStarts.forEach((arrive, k) => {
    const id = Math.floor(arrive / TRACKED_PERIOD_MS);
    const replica = Math.floor(hash01(id, 3) * opts.replicas);
    const s = signals(opts, replica, arrive);
    const ttft = Math.min(TRACKED_PERIOD_MS / 3, s.ttftMedianMs * (1 + hash01(id, 4)));
    const end = Math.min(arrive + ttft + 300 * s.tpotMedianMs, arrive + TRACKED_PERIOD_MS - 1);
    requests.id[k] = id;
    requests.session[k] = Math.floor(id / 5);
    requests.analyst[k] = FIXTURE_TRACKED_ANALYST;
    requests.turn[k] = (id % 5) + 1;
    requests.replica[k] = replica;
    requests.prevReplica[k] = id % 5 === 0 ? -1 : Math.floor(hash01(id - 1, 3) * opts.replicas);
    requests.arriveMs[k] = arrive;
    requests.dispatchMs[k] = arrive + 1;
    requests.firstTokenMs[k] = arrive + ttft;
    requests.endMs[k] = end;
    requests.promptTokens[k] = 800 + 600 * (id % 5);
    requests.cachedTokens[k] =
      requests.prevReplica[k] === replica ? requests.promptTokens[k]! - 200 : 0;
    requests.outputTokens[k] = 300;
    requests.outcome[k] = OUTCOME.finished;
    const steps: [number, number][] = [
      [arrive, REQUEST_STATE.atRouter],
      [arrive + 1, REQUEST_STATE.waiting],
      [arrive + 2, REQUEST_STATE.prefill],
      [arrive + ttft, REQUEST_STATE.decode],
    ];
    steps.forEach(([at, state], j) => {
      const i = k * 4 + j;
      transitions.atMs[i] = at;
      transitions.request[i] = id;
      transitions.analyst[i] = FIXTURE_TRACKED_ANALYST;
      transitions.replica[i] = j === 0 ? -1 : replica;
      transitions.state[i] = state;
    });
  });

  const replicaEvents: ReplicaEvent[] = [];
  if (opts.crash) {
    let prev = phaseCode(replicaPhase(opts, opts.crash.replica, fromMs - 1).phase);
    for (let t = fromMs; t < toMs; t += 1000) {
      const code = phaseCode(replicaPhase(opts, opts.crash.replica, t).phase);
      if (code !== prev) replicaEvents.push({ atMs: t, replica: opts.crash.replica, state: code });
      prev = code;
    }
  }

  return {
    day,
    fromMs,
    toMs,
    replicas: opts.replicas,
    scalars,
    histograms,
    requests,
    transitions,
    replicaEvents,
  };
}

/** Consecutive chunks of chunkMs covering [fromMs, toMs). */
export function makeFixtureChunks(
  opts: FixtureOptions,
  fromMs: SimMs,
  toMs: SimMs,
  chunkMs = 15 * 60_000,
): ResultChunk[] {
  const chunks: ResultChunk[] = [];
  for (let t = fromMs; t < toMs; t += chunkMs)
    chunks.push(makeFixtureChunk(opts, t, Math.min(toMs, t + chunkMs)));
  return chunks;
}
