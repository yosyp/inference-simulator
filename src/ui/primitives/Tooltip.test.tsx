import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.tsx';
import { Tooltip } from './Tooltip.tsx';

function Toolbar({ delayMs = 50 }: { delayMs?: number }) {
  return (
    <>
      <Button>Before</Button>
      <Tooltip content="Re-applies the lesson moment at the playhead" delayMs={delayMs}>
        <Button aria-describedby="hint">Trigger</Button>
      </Tooltip>
      <p id="hint">Hint</p>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Trigger' });
const tooltip = () => screen.queryByRole('tooltip');

describe('Tooltip', () => {
  it('is hidden until needed, and describes its trigger', () => {
    render(<Toolbar />);
    expect(tooltip()).not.toBeInTheDocument();
    const ids = trigger().getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids[0]).toBe('hint');
    const tip = document.getElementById(ids[1]);
    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(tip).toHaveTextContent('Re-applies the lesson moment at the playhead');
  });

  it('shows on keyboard focus at once and hides on blur', async () => {
    const user = userEvent.setup();
    render(<Toolbar delayMs={10_000} />);
    await user.tab();
    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(tooltip()).toHaveTextContent('Re-applies the lesson moment at the playhead');
    await user.tab({ shift: true });
    expect(tooltip()).not.toBeInTheDocument();
  });

  it('stays closed when a click focuses the control', async () => {
    const user = userEvent.setup();
    render(<Toolbar delayMs={10_000} />);
    await user.click(trigger());
    expect(trigger()).toHaveFocus();
    expect(tooltip()).not.toBeInTheDocument();
  });

  it('shows on hover after the delay and hides when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.hover(trigger());
    expect(await screen.findByRole('tooltip')).toBeVisible();
    await user.unhover(trigger());
    await expect.poll(() => tooltip()).toBeNull();
  });

  it('stays open while the pointer moves onto it', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.hover(trigger());
    const tip = await screen.findByRole('tooltip');
    await user.unhover(trigger());
    await user.hover(tip);
    await new Promise((r) => setTimeout(r, 150));
    expect(tooltip()).toBeInTheDocument();
  });

  it('dismisses on Escape without moving focus', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.tab();
    await user.tab();
    expect(tooltip()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(tooltip()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    // Focusing again brings it back.
    await user.tab({ shift: true });
    await user.tab();
    expect(tooltip()).toBeInTheDocument();
  });
});
