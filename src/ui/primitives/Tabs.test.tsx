import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from './Badge.tsx';
import type { TabItem } from './Tabs.tsx';
import { TabPanel, Tabs } from './Tabs.tsx';

const lessons: TabItem[] = [
  { id: 'long-prompt', label: '1 Long prompt' },
  { id: 'knee', label: '2 Knee' },
  { id: 'kv', label: '3 KV exhaustion' },
  { id: 'routing', label: '4 Routing', badge: <Badge>Extrapolated</Badge> },
];

function Harness({
  activation,
  items = lessons,
  onSelect,
}: {
  activation?: 'manual' | 'automatic';
  items?: TabItem[];
  onSelect?: (id: string) => void;
}) {
  const [selected, setSelected] = useState(items[0].id);
  return (
    <>
      <Tabs
        id="lessons"
        label="Lessons"
        items={items}
        selectedId={selected}
        activation={activation}
        onSelect={(id) => {
          setSelected(id);
          onSelect?.(id);
        }}
      />
      <TabPanel tabsId="lessons" selectedId={selected}>
        <button type="button">Play</button>
        <p>Showing {selected}</p>
      </TabPanel>
    </>
  );
}

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });

describe('Tabs', () => {
  it('wires tablist, tabs, and panel with ARIA', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Lessons' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(tab('1 Long prompt')).toHaveAttribute('aria-selected', 'true');
    expect(tab('2 Knee')).toHaveAttribute('aria-selected', 'false');
    const panel = screen.getByRole('tabpanel', { name: '1 Long prompt' });
    expect(tab('2 Knee')).toHaveAttribute('aria-controls', panel.id);
    expect(tab(/4 Routing/)).toHaveTextContent('Extrapolated');
  });

  it('has a roving tabindex: one tab stop, on the selected tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(tab('1 Long prompt')).toHaveAttribute('tabindex', '0');
    for (const name of ['2 Knee', '3 KV exhaustion', /4 Routing/]) {
      expect(tab(name)).toHaveAttribute('tabindex', '-1');
    }
    await user.tab();
    expect(tab('1 Long prompt')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Play' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(tab('1 Long prompt')).toHaveFocus();
  });

  it('moves focus with arrow keys, wrapping, and selects with Enter or Space (manual)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.tab();

    await user.keyboard('{ArrowRight}');
    expect(tab('2 Knee')).toHaveFocus();
    expect(tab('1 Long prompt')).toHaveAttribute('aria-selected', 'true');
    expect(onSelect).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('knee');
    expect(tab('2 Knee')).toHaveAttribute('aria-selected', 'true');
    expect(tab('2 Knee')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel', { name: '2 Knee' })).toHaveTextContent('Showing knee');

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(tab(/4 Routing/)).toHaveFocus();
    await user.keyboard(' ');
    expect(tab(/4 Routing/)).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(tab('1 Long prompt')).toHaveFocus();
  });

  it('jumps with Home and End, skipping disabled tabs', async () => {
    const user = userEvent.setup();
    const items = [...lessons.slice(0, 3), { ...lessons[3], disabled: true }];
    render(<Harness items={items} />);
    await user.tab();
    await user.keyboard('{End}');
    expect(tab('3 KV exhaustion')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab('1 Long prompt')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tab('3 KV exhaustion')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('1 Long prompt')).toHaveFocus();
  });

  it('selects on focus with automatic activation', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness activation="automatic" onSelect={onSelect} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenLastCalledWith('knee');
    expect(tab('2 Knee')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(onSelect).toHaveBeenLastCalledWith('routing');
  });

  it('selects on click, and does not re-select the current tab', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await user.click(tab('1 Long prompt'));
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(tab('3 KV exhaustion'));
    expect(onSelect).toHaveBeenCalledWith('kv');
    expect(screen.getByRole('tabpanel', { name: '3 KV exhaustion' })).toBeInTheDocument();
  });

  it('keeps panel content mounted across tab changes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const play = screen.getByRole('button', { name: 'Play' });
    await user.click(tab('2 Knee'));
    expect(screen.getByRole('button', { name: 'Play' })).toBe(play);
  });
});
