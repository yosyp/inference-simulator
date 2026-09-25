// Step cost model (02-simulator §6): a roofline with three calibrated numbers (η_c, η_b, t_o).
// Every hardware and model number comes from the Calibration; nothing is hard-coded here.
//
//   compute_ms = FLOPs / (η_c × peakDenseFp16Flops)
//   memory_ms  = bytes / (η_b × memoryBandwidthBytesPerSecond)
//   step_ms    = t_o + max(compute_ms, memory_ms)
//              + decodePerSeqMs × decode sequences + cachedTokenMs × cached tokens admitted
//
//   FLOPs = 2 × params × (prefill tokens + decode sequences)
//         + 4 × layers × hiddenSize × attention pairs
//   bytes = weightBytes + kvBytesPerToken × (context tokens read + tokens written)
//
// One rule covers prefill and decode. A sequence that computes n new tokens after p prior tokens
// (cached, or computed by an earlier chunk) is causal: its i-th new token attends to p + i tokens,
// itself included. The step reads the KV of its whole attended context once (p + n tokens, since
// vLLM writes the new K/V into the paged cache before the attention kernel reads it) and writes n.
//
//   attention pairs = Σ_{i=1..n} (p + i) = n·p + n(n + 1)/2
//   KV read         = p + n
//   KV written      = n
//
// A decode step is the case n = 1. With c = p + 1, the tokens the decode token attends to, it
// has c attention pairs, reads c tokens, and writes 1. A request with a P-token prompt that has
// emitted g ≥ 1 output tokens (the last prefill chunk samples the first) decodes with c = P + g.
//
// The two linear terms (X4a) are costs the roofline has no place for, fitted from B2: a per-sequence
// cost of each decode step (sampling, input prep; R2 grows ~97 µs per sequence where the roofline
// stays flat), and a per-token cost of a prefix-cache hit, charged once in the step that admits
// the request (block hashing and lookup; R6). Both default to 0.

import type { Calibration } from '../calibration.ts';

/**
 * Aggregate work in one engine step. Every field is a sum over the batch, so the scheduler (E5)
 * can keep the decode fields as running totals instead of iterating requests:
 *
 * - Admitting a sequence to decode with context c: `decodeSeqs += 1`, `decodeContextTokens += c`.
 * - Removing one (finish, preempt, abort): subtract its current context the same way.
 * - After k decode-only steps, each context grew by k: `decodeContextTokens += k × decodeSeqs`.
 *
 * The prefill fields are rebuilt each step from that step's chunks (few per step) with
 * `addPrefillChunk`. All fields are non-negative integers (token counts). `assertInvariants`
 * checks the relations between them.
 */
export interface StepDesc {
  /** Sequences decoding one token this step. */
  decodeSeqs: number;
  /** Σ over decode sequences of the tokens each attends to (its context, new token included). */
  decodeContextTokens: number;
  /** Σ over prefill chunks of new tokens computed (n). Excludes prefix-cache hits. */
  prefillTokens: number;
  /** Σ over prefill chunks of prior tokens (p): prefix-cache hits plus earlier chunks. */
  prefillPriorTokens: number;
  /** Σ over prefill chunks of causal attention pairs, n·p + n(n + 1)/2 each. */
  prefillAttentionPairs: number;
  /** Prefix-cache hit tokens of the requests admitted this step (part of prefillPriorTokens). */
  prefillCachedTokens: number;
}

/** Cost of one step. Times in ms; FLOPs and bytes are totals for the step. */
export interface StepCost {
  /**
   * t_o + max(computeMs, memoryMs) + the per-sequence and cached-token terms. This is also the
   * step's nvidia-smi-style busy time.
   */
  stepMs: number;
  computeMs: number;
  memoryMs: number;
  flops: number;
  bytes: number;
}

export function emptyStepDesc(): StepDesc {
  return {
    decodeSeqs: 0,
    decodeContextTokens: 0,
    prefillTokens: 0,
    prefillPriorTokens: 0,
    prefillAttentionPairs: 0,
    prefillCachedTokens: 0,
  };
}

export function emptyStepCost(): StepCost {
  return { stepMs: 0, computeMs: 0, memoryMs: 0, flops: 0, bytes: 0 };
}

/** Resets `desc` to an empty step in place. */
export function clearStepDesc(desc: StepDesc): void {
  desc.decodeSeqs = 0;
  desc.decodeContextTokens = 0;
  desc.prefillTokens = 0;
  desc.prefillPriorTokens = 0;
  desc.prefillAttentionPairs = 0;
  desc.prefillCachedTokens = 0;
}

/** Causal attention pairs for n new tokens after p prior tokens: Σ_{i=1..n} (p + i). Exact. */
export function attentionPairs(priorTokens: number, newTokens: number): number {
  return newTokens * priorTokens + (newTokens * (newTokens + 1)) / 2;
}

/** Adds a prefill chunk of `newTokens` after `priorTokens` to `desc` in place. */
export function addPrefillChunk(desc: StepDesc, priorTokens: number, newTokens: number): void {
  desc.prefillTokens += newTokens;
  desc.prefillPriorTokens += priorTokens;
  desc.prefillAttentionPairs += attentionPairs(priorTokens, newTokens);
}

/**
 * Adds a prefill chunk admitted with `cachedTokens` prefix-cache hits: the chunk starts after
 * them, and the step pays cachedTokenMs for each.
 */
export function addAdmittedChunk(desc: StepDesc, cachedTokens: number, newTokens: number): void {
  addPrefillChunk(desc, cachedTokens, newTokens);
  desc.prefillCachedTokens += cachedTokens;
}

/** Adds one decoding sequence whose new token attends to `contextTokens` tokens, itself included. */
export function addDecodeSequence(desc: StepDesc, contextTokens: number): void {
  desc.decodeSeqs += 1;
  desc.decodeContextTokens += contextTokens;
}

// Derived calibration constants. A few multiplications per call, so they are not cached.

/** Achieved FLOPs per ms: η_c × peak / 1000. */
export function flopsPerMs(cal: Calibration): number {
  return (cal.costModel.computeEfficiency * cal.gpu.peakDenseFp16Flops) / 1000;
}

/** Achieved bytes per ms: η_b × bandwidth / 1000. */
export function bytesPerMs(cal: Calibration): number {
  return (cal.costModel.bandwidthEfficiency * cal.gpu.memoryBandwidthBytesPerSecond) / 1000;
}

/** Linear-layer FLOPs per token processed: 2 × params. */
export function linearFlopsPerToken(cal: Calibration): number {
  return 2 * cal.model.params;
}

/** Attention FLOPs per (new token, attended token) pair: 4 × layers × hiddenSize (QKᵀ and AV). */
export function attentionFlopsPerPair(cal: Calibration): number {
  return 4 * cal.model.layers * cal.model.hiddenSize;
}

/** FLOPs of a step. */
export function stepFlops(desc: StepDesc, cal: Calibration): number {
  return (
    linearFlopsPerToken(cal) * (desc.prefillTokens + desc.decodeSeqs) +
    attentionFlopsPerPair(cal) * (desc.prefillAttentionPairs + desc.decodeContextTokens)
  );
}

/** The step time outside the roofline: t_o plus the per-sequence and cached-token terms. */
export function stepExtraMs(desc: StepDesc, cal: Calibration): number {
  const c = cal.costModel;
  return (
    c.stepOverheadMs +
    c.decodePerSeqMs * desc.decodeSeqs +
    c.cachedTokenMs * desc.prefillCachedTokens
  );
}

/** HBM bytes of a step: weights once, plus the KV read and written. */
export function stepBytes(desc: StepDesc, cal: Calibration): number {
  const readTokens = desc.decodeContextTokens + desc.prefillPriorTokens + desc.prefillTokens;
  const writtenTokens = desc.decodeSeqs + desc.prefillTokens;
  return cal.model.weightBytes + cal.model.kvBytesPerToken * (readTokens + writtenTokens);
}

/**
 * Cost of one engine step (02 §6). Writes into `out` and returns it; hot paths pass a reused
 * `out` so nothing is allocated. An empty step (no prefill tokens, no decode sequences) does not
 * run, so it costs zero.
 */
export function stepTime(
  desc: StepDesc,
  cal: Calibration,
  out: StepCost = emptyStepCost(),
): StepCost {
  if (desc.prefillTokens + desc.decodeSeqs === 0) {
    out.stepMs = 0;
    out.computeMs = 0;
    out.memoryMs = 0;
    out.flops = 0;
    out.bytes = 0;
    return out;
  }
  const flops = stepFlops(desc, cal);
  const bytes = stepBytes(desc, cal);
  const computeMs = flops / flopsPerMs(cal);
  const memoryMs = bytes / bytesPerMs(cal);
  out.flops = flops;
  out.bytes = bytes;
  out.computeMs = computeMs;
  out.memoryMs = memoryMs;
  out.stepMs = stepExtraMs(desc, cal) + (computeMs > memoryMs ? computeMs : memoryMs);
  return out;
}

/** Step duration only, in ms. Same as `stepTime(desc, cal).stepMs` without an output object. */
export function stepMs(desc: StepDesc, cal: Calibration): number {
  if (desc.prefillTokens + desc.decodeSeqs === 0) return 0;
  const computeMs = stepFlops(desc, cal) / flopsPerMs(cal);
  const memoryMs = stepBytes(desc, cal) / bytesPerMs(cal);
  return stepExtraMs(desc, cal) + (computeMs > memoryMs ? computeMs : memoryMs);
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`StepDesc invariant: ${message}`);
}

function isCount(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/**
 * Throws if `desc` is inconsistent. Every token attends to at least itself, so the context and
 * attention sums are bounded below by the token counts; each chunk's n·p + n(n+1)/2 ≥ p + n.
 */
export function assertInvariants(desc: StepDesc): void {
  check(isCount(desc.decodeSeqs), `decodeSeqs ${desc.decodeSeqs} is not a count`);
  check(
    isCount(desc.decodeContextTokens),
    `decodeContextTokens ${desc.decodeContextTokens} is not a count`,
  );
  check(isCount(desc.prefillTokens), `prefillTokens ${desc.prefillTokens} is not a count`);
  check(
    isCount(desc.prefillPriorTokens),
    `prefillPriorTokens ${desc.prefillPriorTokens} is not a count`,
  );
  check(
    isCount(desc.prefillAttentionPairs),
    `prefillAttentionPairs ${desc.prefillAttentionPairs} is not a count`,
  );
  check(
    isCount(desc.prefillCachedTokens),
    `prefillCachedTokens ${desc.prefillCachedTokens} is not a count`,
  );
  check(
    desc.prefillCachedTokens <= desc.prefillPriorTokens,
    'prefill cached tokens above prefill prior tokens',
  );
  check(
    desc.decodeContextTokens >= desc.decodeSeqs,
    'each decode sequence attends to at least one token',
  );
  check(desc.decodeSeqs > 0 || desc.decodeContextTokens === 0, 'decode context with no sequences');
  check(
    desc.prefillTokens > 0 || (desc.prefillPriorTokens === 0 && desc.prefillAttentionPairs === 0),
    'prefill prior or attention work with no prefill tokens',
  );
  check(
    desc.prefillAttentionPairs >= desc.prefillPriorTokens + desc.prefillTokens,
    'prefill attention pairs below prior + new tokens',
  );
}
