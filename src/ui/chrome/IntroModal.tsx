// The intro modal (05 §2): shown on every page load, dismissible, with no "don't show again"
// persistence (the app uses no browser storage).

import { useRef } from 'react';
import { Button } from '../primitives/Button.tsx';
import { Modal } from '../primitives/Modal.tsx';

// TODO(copy): the 05 §2 draft, verbatim; X3 writes the final intro text.
export const INTRO_TITLE = 'Inference Simulator';
export const INTRO_PARAGRAPHS: readonly string[] = [
  'An interactive model of serving a large language model inside a fixed-capacity enclave: a set number of GPUs, a known analyst population, and no way to add hardware when load spikes.',
  'Built for the engineers, operators, and program staff who run LLM systems on constrained, high-side networks.',
  'Modelled on Llama 3.1 8B on NVIDIA A100 40GB GPUs; larger configurations are extrapolated. The numbers are provisional until benchmarks land.',
  'The tabs are a teaching order, and every parameter is adjustable.',
];

export interface IntroModalProps {
  open: boolean;
  onClose: () => void;
}

export function IntroModal({ open, onClose }: IntroModalProps) {
  const startRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={INTRO_TITLE}
      initialFocusRef={startRef}
      hideCloseButton
    >
      <div className="flex flex-col gap-2 text-sm text-ink-muted">
        {INTRO_PARAGRAPHS.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <div className="flex justify-end pt-1">
        <Button ref={startRef} variant="primary" onClick={onClose}>
          Start exploring
        </Button>
      </div>
    </Modal>
  );
}
