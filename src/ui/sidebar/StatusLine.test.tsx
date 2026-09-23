import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PlaybackState,
  PlaybackStore,
  ResultsIndex,
  StatusSnapshot,
} from '../../playback/types.ts';
import type { StatusTemplate } from '../../scenarios/schema.ts';
import { snapshot } from '../chrome/testing.tsx';
import { STATUS_FALLBACK, STATUS_MAX_HZ, StatusLine } from './StatusLine.tsx';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A store whose playhead the test moves; statusAt reads a per-time table of snapshots. */
function stubStore(statusAt: (atMs: number) => StatusSnapshot) {
  let state = { playheadMs: 0, mode: 'live' } as PlaybackState;
  const listeners = new Set<() => void>();
  const index = { version: 0, statusAt } as unknown as ResultsIndex;
  const store = {
    getState: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    index,
  } as unknown as PlaybackStore;
  const seek = (playheadMs: number) =>
    act(() => {
      state = { ...state, playheadMs };
      for (const l of listeners) l();
    });
  return { store, seek };
}

const kvTemplates: StatusTemplate[] = [
  {
    id: 'kv',
    priority: 1,
    render: (s) => `KV at ${Math.round(s.replicas[0]!.kvUsedFrac * 100)}%`,
  },
  {
    id: 'preempting',
    priority: 10,
    render: (s) =>
      s.replicas[0]!.preemptionsPerMin > 0
        ? `Replica 1 is preempting; KV at ${Math.round(s.replicas[0]!.kvUsedFrac * 100)}%`
        : null,
  },
];

/** At time t (ms): KV at t% and, from 50 on, preempting. */
const byTime = (t: number) =>
  snapshot([{ kvUsedFrac: t / 100, preemptionsPerMin: t >= 50 ? 2 : 0 }], t);

const line = () => screen.getByText(/KV at|Nothing/);

describe('StatusLine', () => {
  it('is a polite live region showing the highest-priority status at the playhead', () => {
    const { store, seek } = stubStore(byTime);
    render(<StatusLine store={store} templates={kvTemplates} />);
    expect(line()).toHaveAttribute('aria-live', 'polite');
    expect(line()).toHaveAttribute('aria-atomic', 'true');
    expect(line()).toHaveTextContent('KV at 0%');
    seek(60);
    expect(line()).toHaveTextContent('Replica 1 is preempting; KV at 60%');
  });

  it('updates at most STATUS_MAX_HZ times a second, keeping the latest', () => {
    const { store, seek } = stubStore(byTime);
    render(<StatusLine store={store} templates={kvTemplates} />);
    seek(10); // leading edge: shown at once
    expect(line()).toHaveTextContent('KV at 10%');
    seek(20);
    seek(30);
    act(() => vi.advanceTimersByTime(1000 / STATUS_MAX_HZ - 1));
    expect(line()).toHaveTextContent('KV at 10%');
    act(() => vi.advanceTimersByTime(1));
    expect(line()).toHaveTextContent('KV at 30%');
  });

  it('shows a quiet fallback when no template applies', () => {
    const { store } = stubStore(() => snapshot([{}]));
    render(<StatusLine store={store} templates={[]} />);
    expect(line()).toHaveTextContent(STATUS_FALLBACK);
    expect(line()).toHaveAttribute('data-status', 'none');
  });
});
