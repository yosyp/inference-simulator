// Cost model (WP E3, 02-simulator §6 and §11). Pure functions of a Calibration; no state.
// step.ts: one step's time, FLOPs, and bytes from aggregate work (StepDesc).
// decode-span.ts: closed forms for k decode-only steps with a fixed batch, and the inverse.
// utilization.ts: nvidia-smi-style and compute utilization.
// reference.ts: batch-1 TTFT and TPOT for tests, docs, and lesson copy.

export * from './decode-span.ts';
export * from './reference.ts';
export * from './step.ts';
export * from './utilization.ts';
