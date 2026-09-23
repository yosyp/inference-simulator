// Stub chunk producer, used until E9's metrics module supplies produceChunk.
// It returns a contract-valid chunk: zero-filled scalar and histogram blocks covering exactly the
// buckets completed during the advance (so ranges line up with a real producer's), and no records.

import type { DayRunInput } from '../api.ts';
import {
  allocHistogramBlock,
  allocRequestBlock,
  allocScalarBlock,
  allocTransitionBlock,
  type ResultChunk,
} from '../results.ts';
import type { SimMs } from '../time.ts';
import type { ChunkSpan } from './types.ts';

/**
 * End of the last complete histogram bucket once scalar buckets are closed up to `closedMs`.
 * Histogram boundaries are multiples of histBucketMs (it divides DAY_MS, so days align).
 */
function histClosedTo(closedMs: SimMs, histBucketMs: number): SimMs {
  return Math.floor(closedMs / histBucketMs) * histBucketMs;
}

export function emptyChunk(input: DayRunInput, span: ChunkSpan): ResultChunk {
  const { config, day, detail } = input;
  const series = config.replicas + 1;
  const scalarCount = Math.round((span.bucketsToMs - span.bucketsFromMs) / config.bucketMs);
  const histFrom = histClosedTo(span.bucketsFromMs, config.histBucketMs);
  const histTo = histClosedTo(span.bucketsToMs, config.histBucketMs);
  const histCount = Math.round((histTo - histFrom) / config.histBucketMs);
  return {
    day,
    fromMs: span.fromMs,
    toMs: span.toMs,
    replicas: config.replicas,
    scalars: allocScalarBlock(span.bucketsFromMs, config.bucketMs, scalarCount, series),
    histograms: allocHistogramBlock(histFrom, config.histBucketMs, histCount, series),
    requests: allocRequestBlock(detail, 0),
    transitions: allocTransitionBlock(detail, 0),
    replicaEvents: [],
  };
}
