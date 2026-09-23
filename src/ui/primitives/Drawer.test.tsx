import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Drawer, DrawerToggle } from './Drawer.tsx';

// Motion restores scroll after measuring height: 'auto'; jsdom only logs "not implemented".
beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

function Toolbar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DrawerToggle drawerId="params" open={open} onToggle={() => setOpen((o) => !o)}>
        Parameters
      </DrawerToggle>
      <button type="button" onClick={() => setOpen(false)}>
        Reset
      </button>
      <Drawer id="params" open={open} onClose={() => setOpen(false)} title="Parameters">
        <label>
          Routing policy
          <select defaultValue="roundRobin">
            <option value="roundRobin">Round robin</option>
            <option value="affinity">Session affinity</option>
          </select>
        </label>
      </Drawer>
    </>
  );
}

const toggle = () => screen.getByRole('button', { name: 'Parameters' });
const region = () => screen.queryByRole('region', { name: 'Parameters' });

describe('Drawer', () => {
  it('starts closed, with the toggle describing it', () => {
    render(<Toolbar />);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAttribute('aria-controls', 'params');
    expect(region()).not.toBeInTheDocument();
  });

  it('opens from the keyboard and moves focus into the panel', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.tab();
    expect(toggle()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    const panel = region();
    expect(panel).toHaveAttribute('id', 'params');
    expect(panel).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Routing policy' })).toHaveFocus();
  });

  it('closes on Escape and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.click(toggle());
    await user.tab();
    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Routing policy' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveFocus();
    await waitFor(() => expect(region()).not.toBeInTheDocument());
  });

  it('closes from its Close button, returning focus to the toggle', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.click(toggle());
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveFocus();
  });

  it('toggles closed from the toggle itself', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.click(toggle());
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveFocus();
    await waitFor(() => expect(region()).not.toBeInTheDocument());
  });

  it('leaves focus alone when closed from elsewhere', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);
    await user.click(toggle());
    const reset = screen.getByRole('button', { name: 'Reset' });
    await user.click(reset);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(reset).toHaveFocus();
  });
});
