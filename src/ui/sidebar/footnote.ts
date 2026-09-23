// The calibration footnote (05 §8; 01 §9, Q7): the calibration basis and no accuracy claim.
// While the calibration is provisional (03 §8, K10) it says so; X4's switch to 'measured' drops
// the provisional wording with no code change.

import type { Calibration } from '../../engine/calibration.ts';
import type { Preset } from '../../scenarios/schema.ts';

export interface FootnoteText {
  provisional: boolean;
  lines: string[];
}

/** "Llama-3.1-8B-Instruct" reads as "Llama 3.1 8B Instruct". */
function readable(id: string): string {
  return id.replaceAll('-', ' ');
}

// TODO(copy): footnote wording; X3 edits it.
export function footnoteText(calibration: Calibration, preset?: Preset): FootnoteText {
  const model = readable(calibration.model.name);
  const gpu = `NVIDIA ${readable(calibration.source.gpu)}`;
  const provisional = calibration.status === 'provisional';
  const lines = [
    provisional
      ? `The numbers are spec-sheet estimates for ${model} on ${gpu} GPUs until the benchmark measurements are in.`
      : `Calibrated from vLLM ${calibration.source.vllm} benchmarks of ${model} on ${gpu} GPUs.`,
  ];
  if (preset?.basis === 'extrapolated') {
    lines.push(
      `${preset.name} (${preset.replicas} replicas) is extrapolated from per-replica measurements.`,
    );
  }
  lines.push(
    'The shapes carry over to other hardware; the absolute numbers do not. This is a teaching model and makes no accuracy claim.',
  );
  return { provisional, lines };
}
