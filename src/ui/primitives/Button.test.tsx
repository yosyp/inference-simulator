import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';

describe('Button', () => {
  it('is a type="button" by default so it never submits a form', () => {
    render(<Button>Play</Button>);
    expect(screen.getByRole('button', { name: 'Play' })).toHaveAttribute('type', 'button');
  });

  it('activates with Enter and Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Reset</Button>);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reset' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('exposes toggle state with aria-pressed', () => {
    const { rerender } = render(<Button pressed={false}>Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<Button pressed>Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause', pressed: true })).toBeInTheDocument();
    rerender(<Button>Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause' })).not.toHaveAttribute('aria-pressed');
  });

  it('skips disabled buttons in the tab order and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button disabled onClick={onClick}>
          Trigger
        </Button>
        <Button>Next</Button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards refs and extra props', () => {
    let el: HTMLButtonElement | null = null;
    render(
      <Button
        ref={(node) => {
          el = node;
        }}
        aria-label="Jump to lesson moment"
        variant="primary"
        size="sm"
      >
        ⤓
      </Button>,
    );
    expect(el).toBe(screen.getByRole('button', { name: 'Jump to lesson moment' }));
  });
});
