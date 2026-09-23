// Detail windows and traces: re-simulations whose output is not the main stream.
//
// Detail (02 §11, K7, K28). For detail-'tracked' runs, a requestDetail window [fromMs, toMs) is
// re-simulated with detail 'all' from the day's latest checkpoint at or before fromMs (or the
// previous window's run, when the windows follow each other). At fromMs, inFlightTransitions
// places every live request; its rows go first. One 'detail' reply per requestTag, with records,
// transitions, and replica events only. For detail-'all' runs the main chunks already carry every
// request, so the reply is immediate and empty (tracked scope, which the results index ignores).
//
// Traces. After 'track', each day with streamed data is re-simulated from its morning with the
// new analyst, up to where the main stream switched analysts, and posted as one 'trace' chunk
// spanning [day start, that point): the whole day once it is complete. The focus day goes first
// (see host.ts for the order). Only detail-'tracked' runs need traces: under 'all' the main chunks
// already hold every analyst's records. A new 'track' cancels traces still pending.

import { inFlightTransitions } from '../engine/index.ts';
import { chunkTransferables, type ResultChunk } from '../engine/results.ts';
import { dayOf, dayStartMs, type SimMs } from '../engine/time.ts';
import { latestAtOrBefore } from './checkpoints.ts';
import { concatRequests, concatTransitions, inertChunk, recordsChunk } from './blocks.ts';
import { maybeCheckpoint } from './days.ts';
import { nextSilentEnd } from './grid.ts';
import {
  dayEndMs,
  inputFor,
  openRunAt,
  type Active,
  type DetailJob,
  type TraceJob,
} from './state.ts';

function postDetail(h: Active, tag: number, chunk: ResultChunk): void {
  const r = h.run;
  h.post(
    { type: 'detail', runId: r.runId, revision: r.revision, requestTag: tag, chunk },
    chunkTransferables(chunk),
  );
}

/** Answers a detail request with an empty chunk the results index stores but never reads. */
export function answerEmpty(
  h: Active,
  job: Pick<DetailJob, 'tag' | 'day' | 'fromMs' | 'toMs'>,
): void {
  postDetail(h, job.tag, inertChunk(h.setup.scenario.config, job.day, job.fromMs, job.toMs));
}

/** Queues a requestDetail, or answers it now when there is nothing to re-simulate. */
export function requestDetail(h: Active, tag: number, fromMs: SimMs, toMs: SimMs): void {
  const day = dayOf(fromMs);
  const to = Math.min(Math.max(toMs, fromMs), dayEndMs(day));
  const job: DetailJob = { tag, day, fromMs, toMs: to, run: null, inFlight: null, parts: [] };
  if (h.setup.detail === 'all' || to <= fromMs) answerEmpty(h, job);
  else h.run.details.push(job);
}

function openDetailRun(h: Active, job: DetailJob): void {
  const r = h.run;
  const c = r.detailCache;
  const cp = latestAtOrBefore(r.days[job.day]!.checkpoints, job.fromMs);
  const reusable =
    c !== null &&
    c.day === job.day &&
    c.revision === r.revision &&
    c.tracked === r.tracked &&
    c.run.nowMs <= job.fromMs &&
    (!cp || c.run.nowMs >= cp.atMs);
  job.run = reusable ? c.run : openRunAt(h, job.day, job.fromMs, { detail: 'all' });
  if (reusable) r.detailCache = null;
}

/** One unit of a detail job: replay toward fromMs, then the window; posts the reply at the end. */
export function stepDetail(h: Active, job: DetailJob): boolean {
  if (!job.run) openDetailRun(h, job);
  const run = job.run!;
  const g = h.setup.grid;
  const from = run.nowMs;
  if (from < job.fromMs) {
    run.advance(nextSilentEnd(g, job.day, from, job.fromMs));
    maybeCheckpoint(h, h.run.days[job.day]!, run, from);
    return false;
  }
  job.inFlight ??= inFlightTransitions(run.state, { detail: 'all', trackedAnalyst: h.run.tracked });
  if (from < job.toMs) {
    job.parts.push(run.advance(nextSilentEnd(g, job.day, from, job.toMs)));
    maybeCheckpoint(h, h.run.days[job.day]!, run, from);
    if (run.nowMs < job.toMs) return false;
  }
  const config = h.setup.scenario.config;
  const chunk = recordsChunk(
    config,
    job.day,
    job.fromMs,
    job.toMs,
    concatRequests(
      job.parts.map((p) => p.requests),
      'all',
    ),
    concatTransitions([job.inFlight, ...job.parts.map((p) => p.transitions)], 'all'),
    job.parts.flatMap((p) => p.replicaEvents),
  );
  postDetail(h, job.tag, chunk);
  h.run.detailCache = { day: job.day, revision: h.run.revision, tracked: h.run.tracked, run };
  return true;
}

/** One unit of a trace job: replay from the morning; posts the trace at toMs. */
export function stepTrace(h: Active, job: TraceJob): boolean {
  job.run ??= h.engine.createDayRun(
    inputFor(h, job.day, { detail: 'tracked', trackedAnalyst: job.analyst }),
  );
  const run = job.run;
  const from = run.nowMs;
  if (from < job.toMs) {
    job.parts.push(run.advance(nextSilentEnd(h.setup.grid, job.day, from, job.toMs)));
    // The replay from the morning doubles as checkpoint building (densify) for this day.
    maybeCheckpoint(h, h.run.days[job.day]!, run, from);
    if (run.nowMs < job.toMs) return false;
  }
  const r = h.run;
  const chunk = recordsChunk(
    h.setup.scenario.config,
    job.day,
    dayStartMs(job.day),
    job.toMs,
    concatRequests(
      job.parts.map((p) => p.requests),
      'tracked',
      job.toMs,
    ),
    concatTransitions(
      job.parts.map((p) => p.transitions),
      'tracked',
      job.toMs,
    ),
  );
  h.post(
    {
      type: 'trace',
      runId: r.runId,
      revision: r.revision,
      analyst: job.analyst,
      day: job.day,
      chunk,
    },
    chunkTransferables(chunk),
  );
  return true;
}
