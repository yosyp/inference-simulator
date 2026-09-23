import { describe, expect, it, vi } from 'vitest';
import type { StatusTemplate } from '../../scenarios/schema.ts';
import { snapshot } from '../chrome/testing.tsx';
import { byPriority, evaluateStatus } from './status.ts';

const preempting: StatusTemplate = {
  id: 'preempting',
  priority: 10,
  render: (s) => {
    const r = s.replicas.find((x) => x.preemptionsPerMin > 0);
    return r
      ? `Replica ${r.replica + 1} is preempting; KV at ${Math.round(r.kvUsedFrac * 100)}%`
      : null;
  },
};
const kvHigh: StatusTemplate = {
  id: 'kvHigh',
  priority: 5,
  render: (s) => {
    const r = s.replicas.find((x) => x.kvUsedFrac >= 0.9);
    return r ? `Replica ${r.replica + 1} KV at ${Math.round(r.kvUsedFrac * 100)}%` : null;
  },
};
const idle: StatusTemplate = { id: 'idle', priority: 0, render: () => 'All replicas are ready.' };

describe('evaluateStatus', () => {
  it('picks the highest-priority template that applies', () => {
    const templates = [idle, kvHigh, preempting];
    expect(evaluateStatus(templates, snapshot([{}, {}]))).toEqual({
      id: 'idle',
      text: 'All replicas are ready.',
    });
    expect(evaluateStatus(templates, snapshot([{}, { kvUsedFrac: 0.93 }]))).toEqual({
      id: 'kvHigh',
      text: 'Replica 2 KV at 93%',
    });
    expect(
      evaluateStatus(templates, snapshot([{ kvUsedFrac: 0.98, preemptionsPerMin: 4 }, {}])),
    ).toEqual({ id: 'preempting', text: 'Replica 1 is preempting; KV at 98%' });
  });

  it('returns null when no template applies', () => {
    expect(evaluateStatus([preempting, kvHigh], snapshot([{}]))).toBeNull();
    expect(evaluateStatus([], snapshot([{}]))).toBeNull();
  });

  it('treats blank text as not applying', () => {
    const blank: StatusTemplate = { id: 'blank', priority: 99, render: () => '  ' };
    expect(evaluateStatus([blank, idle], snapshot([{}]))?.id).toBe('idle');
  });

  it('breaks ties by listed order', () => {
    const a: StatusTemplate = { id: 'a', priority: 1, render: () => 'A' };
    const b: StatusTemplate = { id: 'b', priority: 1, render: () => 'B' };
    expect(evaluateStatus([a, b], snapshot([{}]))?.id).toBe('a');
    expect(evaluateStatus([b, a], snapshot([{}]))?.id).toBe('b');
    expect(byPriority([idle, b, preempting, a]).map((t) => t.id)).toEqual([
      'preempting',
      'b',
      'a',
      'idle',
    ]);
  });

  it('skips a template that throws, and reports it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: StatusTemplate = {
      id: 'broken',
      priority: 50,
      render: () => {
        throw new Error('boom');
      },
    };
    expect(evaluateStatus([broken, idle], snapshot([{}]))?.id).toBe('idle');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
