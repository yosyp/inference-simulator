// K18: chrome transitions are off under prefers-reduced-motion, and follow live setting changes.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../primitives/Modal.tsx';
import { chromeTransition, motionTokens, usePrefersReducedMotion } from './motion.ts';

function stubReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, l: () => void) => listeners.add(l),
    removeEventListener: (_type: string, l: () => void) => listeners.delete(l),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  return {
    set(matches: boolean) {
      mql.matches = matches;
      for (const l of listeners) l();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reduced motion', () => {
  it('defaults to full motion when matchMedia is unavailable (jsdom)', () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('follows the media query, including live changes', () => {
    const media = stubReducedMotion(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
  });

  it('zeroes chrome transitions when reduced', () => {
    expect(chromeTransition(true)).toEqual({ duration: 0 });
    expect(chromeTransition(false, 'fast')).toEqual({
      duration: motionTokens.durationS.fast,
      ease: motionTokens.ease,
    });
  });

  it('closes a modal without an exit animation', async () => {
    stubReducedMotion(true);
    const user = userEvent.setup();
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <Modal open={open} onClose={() => setOpen(false)} title="Intro">
          <p>Body</p>
        </Modal>
      );
    }
    render(<Page />);
    await user.keyboard('{Escape}');
    // With zero duration the dialog is gone within a frame or two.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), {
      timeout: 50,
    });
  });
});
