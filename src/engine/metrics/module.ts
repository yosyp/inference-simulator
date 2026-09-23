// The metrics module (00-build E9): last in module order and the only chunk producer. It listens
// to the lifecycle topics, reads the shared meters at bucket ends, and owns the level takes.
// Event kinds 500–599 are reserved for it; it schedules none.

import { TOPIC } from '../core/ids.ts';
import { defineModule } from '../core/types.ts';
import { closeBucket, produceChunk } from './buckets.ts';
import { assertMetrics } from './invariants.ts';
import {
  onArrived,
  onDispatched,
  onEnded,
  onFirstToken,
  onReplicaState,
  onRequestState,
} from './notices.ts';
import { createMetricsSlice } from './slice.ts';

export const metricsModule = defineModule({
  name: 'metrics',
  init(state, ctx) {
    const { replicas, bucketMs, histBucketMs, shift } = ctx.input.config;
    return createMetricsSlice(state, ctx.nowMs, { replicas, bucketMs, histBucketMs, shift });
  },
  notices: [
    { topic: TOPIC.requestArrived, handle: onArrived },
    { topic: TOPIC.requestDispatched, handle: onDispatched },
    { topic: TOPIC.requestState, handle: onRequestState },
    { topic: TOPIC.firstToken, handle: onFirstToken },
    { topic: TOPIC.requestEnded, handle: onEnded },
    { topic: TOPIC.replicaState, handle: onReplicaState },
  ],
  onBucketEnd: closeBucket,
  produceChunk,
  assertInvariants: assertMetrics,
});
