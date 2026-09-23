// Batch-1 reference latencies for tests, docs, and lesson copy (tab 1, K3). Not used on hot paths.

import type { Calibration } from '../calibration.ts';
import {
  addDecodeSequence,
  addPrefillChunk,
  clearStepDesc,
  emptyStepDesc,
  stepMs,
} from './step.ts';

/**
 * Batch-1 TTFT in ms for a prompt of `promptTokens`, prefilled in chunks of at most `chunkTokens`
 * (chunked prefill; vLLM's max_num_batched_tokens at batch 1). It is the sum of the chunk steps;
 * the last chunk's step samples the first token. Queueing is excluded.
 *
 * `cachedTokens` prefix-cache hits skip compute. As in vLLM, at least the last prompt token is
 * always computed, so hits are capped at promptTokens − 1.
 */
export function batch1TtftMs(
  promptTokens: number,
  chunkTokens: number,
  cal: Calibration,
  cachedTokens = 0,
): number {
  if (!(promptTokens >= 1) || !(chunkTokens >= 1) || !(cachedTokens >= 0)) {
    const got = `${promptTokens}, ${chunkTokens}, ${cachedTokens}`;
    throw new RangeError(`batch1TtftMs: need prompt ≥ 1, chunk ≥ 1, cached ≥ 0 (got ${got})`);
  }
  const desc = emptyStepDesc();
  let prior = Math.min(cachedTokens, promptTokens - 1);
  let ms = 0;
  while (prior < promptTokens) {
    const n = Math.min(chunkTokens, promptTokens - prior);
    clearStepDesc(desc);
    addPrefillChunk(desc, prior, n);
    ms += stepMs(desc, cal);
    prior += n;
  }
  return ms;
}

/**
 * Batch-1 TPOT in ms: one decode step for a sequence whose new token attends to `contextTokens`
 * tokens (prompt plus output so far, itself included).
 */
export function batch1TpotMs(contextTokens: number, cal: Calibration): number {
  const desc = emptyStepDesc();
  addDecodeSequence(desc, contextTokens);
  return stepMs(desc, cal);
}
