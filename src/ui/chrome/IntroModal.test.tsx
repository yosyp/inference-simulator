import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { INTRO_PARAGRAPHS, IntroModal } from './IntroModal.tsx';

function Page() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        About
      </button>
      <IntroModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('IntroModal', () => {
  it('opens with the 05 §2 text and focus on Start exploring', () => {
    render(<Page />);
    const dialog = screen.getByRole('dialog', { name: 'Inference Simulator' });
    for (const p of INTRO_PARAGRAPHS) expect(dialog).toHaveTextContent(p);
    expect(screen.getByRole('button', { name: 'Start exploring' })).toHaveFocus();
    // Under ~120 words (05 §2).
    expect(INTRO_PARAGRAPHS.join(' ').split(/\s+/).length).toBeLessThan(120);
  });

  it('closes with Start exploring', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Start exploring' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes with Escape and can be reopened', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'About' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
