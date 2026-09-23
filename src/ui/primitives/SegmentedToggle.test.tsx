import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SegmentedOption } from './SegmentedToggle.tsx';
import { SegmentedToggle } from './SegmentedToggle.tsx';

type View = 'live' | 'highSide';
const modes: SegmentedOption<View>[] = [
  { value: 'live', label: 'Live' },
  { value: 'highSide', label: 'High side', description: 'Daily rollups only' },
];

function ModeToggle({
  initial = 'live',
  onChange,
  options = modes,
}: {
  initial?: View;
  onChange?: (v: View) => void;
  options?: SegmentedOption<View>[];
}) {
  const [value, setValue] = useState<View>(initial);
  return (
    <>
      <button type="button">Before</button>
      <SegmentedToggle
        label="Telemetry view"
        options={options}
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button type="button">After</button>
    </>
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('SegmentedToggle', () => {
  it('is a labelled radio group with the value checked', () => {
    render(<ModeToggle />);
    expect(screen.getByRole('radiogroup', { name: 'Telemetry view' })).toBeInTheDocument();
    expect(radio('Live')).toBeChecked();
    expect(radio('High side')).not.toBeChecked();
    expect(radio('High side')).toHaveAccessibleDescription('Daily rollups only');
  });

  it('has one tab stop, on the checked option', async () => {
    const user = userEvent.setup();
    render(<ModeToggle initial="highSide" />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(radio('High side')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('moves and selects with arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModeToggle onChange={onChange} />);
    await user.click(radio('Live'));
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard('{ArrowRight}');
    expect(radio('High side')).toHaveFocus();
    expect(radio('High side')).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith('highSide');

    await user.keyboard('{ArrowRight}');
    expect(radio('Live')).toHaveFocus();
    expect(radio('Live')).toBeChecked();

    await user.keyboard('{ArrowLeft}');
    expect(radio('High side')).toBeChecked();
    await user.keyboard('{ArrowUp}');
    expect(radio('Live')).toBeChecked();
    await user.keyboard('{ArrowDown}');
    expect(radio('High side')).toBeChecked();
  });

  it('jumps with Home and End and skips disabled options', async () => {
    const user = userEvent.setup();
    type Speed = '1' | '10' | '100' | '1000';
    function Speeds() {
      const [v, setV] = useState<Speed>('10');
      return (
        <SegmentedToggle<Speed>
          label="Speed"
          value={v}
          onChange={setV}
          options={[
            { value: '1', label: '1×' },
            { value: '10', label: '10×' },
            { value: '100', label: '100×', disabled: true },
            { value: '1000', label: '1000×' },
          ]}
        />
      );
    }
    render(<Speeds />);
    await user.tab();
    expect(radio('10×')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(radio('1000×')).toBeChecked();
    await user.keyboard('{Home}');
    expect(radio('1×')).toBeChecked();
    expect(radio('1×')).toHaveFocus();
    await user.keyboard('{End}');
    expect(radio('1000×')).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(radio('10×')).toBeChecked();
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    render(<ModeToggle />);
    await user.click(radio('High side'));
    expect(radio('High side')).toBeChecked();
    expect(radio('High side')).toHaveFocus();
  });
});
