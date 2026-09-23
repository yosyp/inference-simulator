// The two utilization metrics (02 §11; tab 3 contrasts them). The recorder (E9) accumulates
// busyMs and flops per bucket (SCALAR_METRICS in results.ts) and divides by the bucket width.
//
// nvidia-smi-style utilization = busy time ÷ elapsed time. A step counts as busy for its whole
// duration, t_o included, from start to finish. nvidia-smi reports the fraction of sample periods
// in which any kernel ran, and a serving engine that runs steps back to back reads ~100% however
// little of the GPU's arithmetic each step uses. The model does not split t_o into GPU-idle and
// GPU-busy parts; the whole step is busy.
//
// Compute utilization = achieved FLOPs ÷ (peakDenseFp16Flops × elapsed). The denominator is the
// spec-sheet peak, not η_c × peak, so a fully compute-bound engine reads at most
// η_c × computeMs / (t_o + computeMs), below η_c. Memory-bound decode reads far lower. That gap
// between the two metrics is the lesson: "100% busy" says nothing about how much work is done.

import type { Calibration } from '../calibration.ts';

/** Busy fraction 0..1 over `elapsedMs`; 0 for an empty interval. */
export function nvidiaSmiUtilization(busyMs: number, elapsedMs: number): number {
  return elapsedMs > 0 ? busyMs / elapsedMs : 0;
}

/** Achieved FLOPs over `elapsedMs` as a fraction of spec-sheet peak; 0 for an empty interval. */
export function computeUtilization(flops: number, elapsedMs: number, cal: Calibration): number {
  return elapsedMs > 0 ? (flops * 1000) / (cal.gpu.peakDenseFp16Flops * elapsedMs) : 0;
}
