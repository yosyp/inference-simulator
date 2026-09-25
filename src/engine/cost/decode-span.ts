// Closed forms for a run of decode-only steps with a fixed batch (02 §5 event-jumping, §6).
//
// A decode-only batch of B sequences whose tokens attend to C0 tokens in total at step 0. Every
// step adds one token per sequence, so step j (0-based) attends to C_j = C0 + j·B tokens, reads
// C_j KV tokens, and writes B (see step.ts for the rule). Both roofline terms are linear in j:
//
//   FLOPs_j  = 2·params·B + 4·layers·hidden·(C0 + j·B)        compute_j = FLOPs_j / (η_c·peak)
//   bytes_j  = weights + kv·(C0 + B) + kv·B·j                  memory_j  = bytes_j / (η_b·bw)
//   step_j   = t_o + decodePerSeqMs·B + max(compute_j, memory_j)
//
// The per-sequence term is constant within a span (B is fixed), so it folds into overheadMs and
// every closed form below stays exact. A decode-only step admits nothing, so no cached-token term.
//
// The max of two lines switches at most once. The span stores the line that binds at step 0
// ("first") and the other ("second"); steps [0, switchStep) follow the first and steps
// [switchStep, ∞) the second. switchStep is Infinity when the first line never falls behind.
// Typical decode starts compute-bound at large B and short context and turns memory-bound as the
// KV read grows, because the KV slope per step (kv/bw) far exceeds the attention slope.
//
// With S = min(k, switchStep) and line x0 + x1·j, the duration of the first k steps is
//   D(k) = S·(t_o + f0) + f1·S(S−1)/2 + Σ_{j=S}^{k−1} (t_o + s0 + s1·j),
// a quadratic per piece. The inverse solves that quadratic, then fixes the integer by checking
// D(k) ≤ T < D(k + 1) with the same closed form, so it is exact at every boundary.

import type { Calibration } from '../calibration.ts';
import { attentionFlopsPerPair, bytesPerMs, flopsPerMs, linearFlopsPerToken } from './step.ts';

/**
 * Precomputed per-step lines for one fixed decode batch. Plain data (structuredClone-safe).
 * Build it with `decodeSpan` when the batch changes and query it until the next change.
 */
export interface DecodeSpan {
  /** B: sequences in the batch. */
  batch: number;
  /** C0: Σ tokens attended by the batch at step 0. Step j attends C0 + j·B. */
  contextTokens: number;
  /** Per-step time outside the roofline: t_o + decodePerSeqMs·B. */
  overheadMs: number;
  /** Whether compute binds at step 0. */
  firstComputeBound: boolean;
  /** Binding term at step j < switchStep: firstMs0 + firstMsSlope·j (excluding t_o). */
  firstMs0: number;
  firstMsSlope: number;
  /** Binding term at step j ≥ switchStep. */
  secondMs0: number;
  secondMsSlope: number;
  /** First step index at which the second line binds; Infinity if it never does. */
  switchStep: number;
  /** FLOPs_j = flops0 + flopsSlope·j. */
  flops0: number;
  flopsSlope: number;
  /** bytes_j = bytes0 + bytesSlope·j. */
  bytes0: number;
  bytesSlope: number;
}

export function emptyDecodeSpan(): DecodeSpan {
  return {
    batch: 0,
    contextTokens: 0,
    overheadMs: 0,
    firstComputeBound: false,
    firstMs0: 0,
    firstMsSlope: 0,
    secondMs0: 0,
    secondMsSlope: 0,
    switchStep: Infinity,
    flops0: 0,
    flopsSlope: 0,
    bytes0: 0,
    bytesSlope: 0,
  };
}

/**
 * Builds the span for a decode-only batch of `batch` ≥ 1 sequences attending to `contextTokens`
 * tokens in total at its first step (the StepDesc's `decodeSeqs` and `decodeContextTokens`).
 * Writes into `out` and returns it; pass a reused `out` in hot paths.
 */
export function decodeSpan(
  batch: number,
  contextTokens: number,
  cal: Calibration,
  out: DecodeSpan = emptyDecodeSpan(),
): DecodeSpan {
  if (!(batch >= 1)) throw new RangeError(`decodeSpan: batch ${batch} must be at least 1`);
  const attention = attentionFlopsPerPair(cal);
  const kv = cal.model.kvBytesPerToken;
  const flops0 = linearFlopsPerToken(cal) * batch + attention * contextTokens;
  const flopsSlope = attention * batch;
  const bytes0 = cal.model.weightBytes + kv * (contextTokens + batch);
  const bytesSlope = kv * batch;
  const fpm = flopsPerMs(cal);
  const bpm = bytesPerMs(cal);
  const c0 = flops0 / fpm;
  const c1 = flopsSlope / fpm;
  const m0 = bytes0 / bpm;
  const m1 = bytesSlope / bpm;
  // On a tie at step 0, the steeper line binds from then on.
  const computeFirst = c0 > m0 || (c0 === m0 && c1 >= m1);
  const f0 = computeFirst ? c0 : m0;
  const f1 = computeFirst ? c1 : m1;
  const s0 = computeFirst ? m0 : c0;
  const s1 = computeFirst ? m1 : c1;

  out.batch = batch;
  out.contextTokens = contextTokens;
  out.overheadMs = cal.costModel.stepOverheadMs + cal.costModel.decodePerSeqMs * batch;
  out.firstComputeBound = computeFirst;
  out.firstMs0 = f0;
  out.firstMsSlope = f1;
  out.secondMs0 = s0;
  out.secondMsSlope = s1;
  // The first line binds while f0 + f1·j ≥ s0 + s1·j, i.e. for j ≤ (f0 − s0) / (s1 − f1).
  out.switchStep = s1 > f1 ? Math.floor((f0 - s0) / (s1 - f1)) + 1 : Infinity;
  out.flops0 = flops0;
  out.flopsSlope = flopsSlope;
  out.bytes0 = bytes0;
  out.bytesSlope = bytesSlope;
  return out;
}

/** Σ_{j=from}^{from+n−1} (x0 + x1·j). */
function lineSum(x0: number, x1: number, from: number, n: number): number {
  return n * x0 + x1 * (from * n + (n * (n - 1)) / 2);
}

/** Duration in ms of step j (0-based) of the span. */
export function decodeSpanStepMs(span: DecodeSpan, step: number): number {
  const binding =
    step < span.switchStep
      ? span.firstMs0 + span.firstMsSlope * step
      : span.secondMs0 + span.secondMsSlope * step;
  return span.overheadMs + binding;
}

/** Duration in ms of the first `steps` steps (a non-negative integer, or Infinity). D(0) = 0. */
export function decodeSpanDurationMs(span: DecodeSpan, steps: number): number {
  if (steps <= 0) return 0;
  const s = span.switchStep;
  const first = steps < s ? steps : s;
  let ms = lineSum(span.overheadMs + span.firstMs0, span.firstMsSlope, 0, first);
  if (steps > s) ms += lineSum(span.overheadMs + span.secondMs0, span.secondMsSlope, s, steps - s);
  return ms;
}

/**
 * nvidia-smi-style busy time of the first `steps` steps. A step counts as busy for its full
 * duration, t_o included, and the steps of a span run back to back, so this equals the duration.
 */
export function decodeSpanBusyMs(span: DecodeSpan, steps: number): number {
  return decodeSpanDurationMs(span, steps);
}

/** Achieved FLOPs over the first `steps` steps. */
export function decodeSpanFlops(span: DecodeSpan, steps: number): number {
  return steps <= 0 ? 0 : lineSum(span.flops0, span.flopsSlope, 0, steps);
}

/** HBM bytes over the first `steps` steps. */
export function decodeSpanBytes(span: DecodeSpan, steps: number): number {
  return steps <= 0 ? 0 : lineSum(span.bytes0, span.bytesSlope, 0, steps);
}

/**
 * floor of the largest real x ≥ 0 with base·x + slope·x(x − 1)/2 ≤ budget, i.e. the positive root
 * of (slope/2)x² + (base − slope/2)x − budget = 0. base > 0 and slope ≥ 0.
 */
function solveSteps(base: number, slope: number, budgetMs: number): number {
  if (budgetMs <= 0) return 0;
  if (slope === 0) return Math.floor(budgetMs / base);
  const b = base - slope / 2;
  const root = Math.sqrt(b * b + 2 * slope * budgetMs);
  // Pick the form without cancellation.
  const x = b >= 0 ? (2 * budgetMs) / (b + root) : (root - b) / slope;
  return Math.floor(x);
}

/**
 * The largest k with decodeSpanDurationMs(span, k) ≤ budgetMs: how many steps complete within
 * the budget. Returns 0 for a negative or NaN budget and Infinity for an infinite one.
 */
export function decodeSpanStepsWithin(span: DecodeSpan, budgetMs: number): number {
  if (!(budgetMs >= 0)) return 0;
  if (budgetMs === Infinity) return Infinity;
  const s = span.switchStep;
  let k: number;
  const atSwitch = s < Infinity ? decodeSpanDurationMs(span, s) : Infinity;
  if (atSwitch <= budgetMs) {
    const base = span.overheadMs + span.secondMs0 + span.secondMsSlope * s;
    k = s + solveSteps(base, span.secondMsSlope, budgetMs - atSwitch);
  } else {
    k = solveSteps(span.overheadMs + span.firstMs0, span.firstMsSlope, budgetMs);
  }
  // The root is within a step of the answer; settle the integer with the exact closed form.
  // The k ± 1 !== k guards stop at magnitudes where integers are no longer representable.
  while (k > 0 && k - 1 !== k && decodeSpanDurationMs(span, k) > budgetMs) k--;
  while (k + 1 !== k && decodeSpanDurationMs(span, k + 1) <= budgetMs) k++;
  return k;
}
