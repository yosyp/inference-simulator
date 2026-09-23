import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell.tsx';

const original = { width: window.innerWidth, height: window.innerHeight };

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => setViewport(original.width, original.height));

function Page({ mode }: { mode?: 'live' | 'highSide' }) {
  return (
    <AppShell
      mode={mode}
      tabs={<div role="tablist" aria-label="Lessons" />}
      toolbar={<button type="button">Play</button>}
      canvas={<canvas aria-label="Replicas" />}
      charts={<p>Chart placeholder</p>}
      timeline={<p>Timeline placeholder</p>}
      sidebar={<p>What to watch</p>}
    />
  );
}

describe('AppShell', () => {
  it('places each slot in its landmark', () => {
    setViewport(1440, 900);
    render(<Page />);
    const main = screen.getByRole('main', { name: 'Simulator' });
    expect(within(main).getByRole('tablist', { name: 'Lessons' })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: 'Play' })).toBeInTheDocument();
    const sim = within(main).getByRole('region', { name: 'Simulation' });
    expect(within(sim).getByLabelText('Replicas')).toBeInTheDocument();
    expect(within(main).getByRole('region', { name: 'Charts' })).toHaveTextContent(
      'Chart placeholder',
    );
    expect(within(main).getByRole('region', { name: 'Week timeline' })).toHaveTextContent(
      'Timeline placeholder',
    );
    const aside = screen.getByRole('complementary', { name: 'About this tab' });
    expect(aside).toHaveTextContent('What to watch');
  });

  it('orders the simulator column tabs, toolbar, canvas, charts, timeline', () => {
    setViewport(1440, 900);
    const { container } = render(<Page />);
    const slots = [...container.querySelectorAll('[data-slot]')].map((el) =>
      el.getAttribute('data-slot'),
    );
    expect(slots).toEqual(['tabs', 'toolbar', 'scroll', 'canvas', 'charts', 'timeline', 'sidebar']);
  });

  it('keeps the tab order: tabs and toolbar, then content, then sidebar', async () => {
    setViewport(1440, 900);
    const user = userEvent.setup();
    render(
      <AppShell
        tabs={<button type="button">Tab</button>}
        toolbar={<button type="button">Tool</button>}
        canvas={<button type="button">Canvas</button>}
        charts={<button type="button">Chart</button>}
        timeline={<button type="button">Scrub</button>}
        sidebar={<button type="button">More</button>}
      />,
    );
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab();
      order.push(document.activeElement?.textContent ?? '');
    }
    expect(order).toEqual(['Tab', 'Tool', 'Canvas', 'Chart', 'Scrub', 'More']);
  });

  it.each([
    [1440, 900],
    [1280, 720],
    [1920, 1080],
  ])('shows no notice at %i×%i', (w, h) => {
    setViewport(w, h);
    render(<Page />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each([
    [1279, 900],
    [1440, 719],
    [1024, 768],
  ])('asks for a larger window at %i×%i', (w, h) => {
    setViewport(w, h);
    render(<Page />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Please use a larger window.');
    expect(notice).toHaveTextContent(`${w} × ${h}`);
    // The app stays mounted underneath.
    expect(screen.getByRole('main', { name: 'Simulator' })).toBeInTheDocument();
  });

  it('shows and hides the notice as the window resizes', () => {
    setViewport(1440, 900);
    render(<Page />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    setViewport(1200, 700);
    expect(screen.getByRole('status')).toHaveTextContent('1200 × 700');
    setViewport(1300, 800);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('marks the High-side view', () => {
    setViewport(1440, 900);
    const { container, rerender } = render(<Page />);
    const root = container.firstElementChild;
    expect(root).toHaveAttribute('data-mode', 'live');
    expect(container.querySelector('[data-slot="mode-rule"]')).toBeNull();
    rerender(<Page mode="highSide" />);
    expect(root).toHaveAttribute('data-mode', 'highSide');
    expect(container.querySelector('[data-slot="mode-rule"]')).not.toBeNull();
  });
});
