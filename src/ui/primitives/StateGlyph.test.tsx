import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { dotStyles, replicaStyles } from '../theme/encodings.ts';
import { DotGlyph, ReplicaGlyph } from './StateGlyph.tsx';

describe('DotGlyph', () => {
  it.each(Object.keys(dotStyles) as (keyof typeof dotStyles)[])(
    'draws %s with its shape and stroke',
    (state) => {
      const { container } = render(<DotGlyph state={state} />);
      const svg = container.querySelector('svg');
      const style = dotStyles[state];
      expect(svg).toHaveAttribute('data-shape', style.shape);
      const mark = svg?.querySelector(style.shape === 'diamond' ? 'path' : 'circle');
      expect(mark).toHaveAttribute('stroke', style.stroke);
      expect(mark).toHaveAttribute('fill', style.fill ?? 'none');
    },
  );

  it('is decorative unless titled', () => {
    const { container } = render(<DotGlyph state="decode" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    render(<DotGlyph state="preempted" title="Preempted" />);
    expect(screen.getByRole('img', { name: 'Preempted' })).toBeInTheDocument();
  });
});

describe('ReplicaGlyph', () => {
  it('hatches Down and Crashed', () => {
    for (const state of ['down', 'crashed'] as const) {
      const { container } = render(<ReplicaGlyph state={state} />);
      expect(container.querySelector('pattern line')).toHaveAttribute(
        'stroke',
        replicaStyles[state].hatch?.color,
      );
    }
  });

  it('dashes Loading and shows its progress', () => {
    const { container } = render(
      <ReplicaGlyph state="loadingWeights" progress={0.25} width={28} />,
    );
    const outline = container.querySelector('rect[stroke-dasharray]');
    expect(outline).toHaveAttribute('stroke-dasharray', '5 3');
    const bar = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('fill') === replicaStyles.loadingWeights.progress?.fill,
    );
    expect(bar).toHaveAttribute('width', String((28 - 8) * 0.25));
  });

  it('draws Ready with a solid outline and a KV tank', () => {
    const { container } = render(<ReplicaGlyph state="ready" title="Ready" />);
    expect(container.querySelector('[stroke-dasharray]')).toBeNull();
    expect(container.querySelector('pattern')).toBeNull();
    expect(screen.getByRole('img', { name: 'Ready' })).toBeInTheDocument();
  });
});
