import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';

function Page({
  startOpen = false,
  closeOnBackdrop,
  useInitialFocus = false,
  onClose,
}: {
  startOpen?: boolean;
  closeOnBackdrop?: boolean;
  useInitialFocus?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const start = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>About</Button>
      <Button>Play</Button>
      <Modal
        open={open}
        onClose={close}
        title="Inference Simulator"
        closeOnBackdrop={closeOnBackdrop}
        initialFocusRef={useInitialFocus ? start : undefined}
      >
        <p>An interactive model of serving a large language model.</p>
        <a href="#docs">Read more</a>
        <Button ref={start} variant="primary" onClick={close}>
          Start exploring
        </Button>
      </Modal>
    </>
  );
}

const dialog = () => screen.queryByRole('dialog', { name: 'Inference Simulator' });

async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  await user.tab();
  expect(screen.getByRole('button', { name: 'About' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(dialog()).toBeInTheDocument();
}

describe('Modal', () => {
  it('is an aria-modal dialog labelled by its title', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(dialog()).not.toBeInTheDocument();
    await openWithKeyboard(user);
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
  });

  it('moves focus to the first tabbable element on open', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openWithKeyboard(user);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('honors initialFocusRef', async () => {
    const user = userEvent.setup();
    render(<Page useInitialFocus />);
    await openWithKeyboard(user);
    expect(screen.getByRole('button', { name: 'Start exploring' })).toHaveFocus();
  });

  it('traps focus: Tab and Shift+Tab wrap inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openWithKeyboard(user);
    const close = screen.getByRole('button', { name: 'Close' });
    const link = screen.getByRole('link', { name: 'Read more' });
    const start = screen.getByRole('button', { name: 'Start exploring' });

    await user.tab();
    expect(link).toHaveFocus();
    await user.tab();
    expect(start).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(start).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    await openWithKeyboard(user);
    await user.tab();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'About' })).toHaveFocus();
    await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  });

  it('returns focus to the opener under StrictMode (effects run twice on mount)', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    await openWithKeyboard(user);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'About' })).toHaveFocus();
  });

  it('returns focus after closing from a button inside', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await openWithKeyboard(user);
    await user.click(screen.getByRole('button', { name: 'Start exploring' }));
    expect(screen.getByRole('button', { name: 'About' })).toHaveFocus();
    await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  });

  it('closes on a backdrop click unless disabled', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<Page startOpen onClose={onClose} />);
    const backdrop = dialog()?.parentElement;
    if (!backdrop) throw new Error('no backdrop');
    await user.click(screen.getByText(/interactive model/));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onClose2 = vi.fn();
    render(<Page startOpen closeOnBackdrop={false} onClose={onClose2} />);
    const backdrop2 = dialog()?.parentElement;
    if (!backdrop2) throw new Error('no backdrop');
    await user.click(backdrop2);
    expect(onClose2).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it('can open on first render (the intro modal on every load)', () => {
    render(<Page startOpen />);
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});
