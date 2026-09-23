import { describe, expect, it, vi } from 'vitest';
import type { WorkerToMain } from '../worker/protocol.ts';
import { fromWorker, type WorkerLike } from './transport.ts';

function fakeWorker() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: (type: string, l: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener: (type: string, l: (e: unknown) => void) => {
      listeners.get(type)?.delete(l);
    },
  };
  const fire = (type: string, e: unknown) => listeners.get(type)?.forEach((l) => l(e));
  return { worker: worker as unknown as WorkerLike & typeof worker, fire, listeners };
}

describe('fromWorker', () => {
  it('posts messages with their transfer list and dispatches replies', () => {
    const { worker, fire } = fakeWorker();
    const t = fromWorker(worker);
    const got: WorkerToMain[] = [];
    t.onMessage((m) => got.push(m));
    const buffer = new ArrayBuffer(8);
    t.postMessage({ type: 'focus', runId: 3, atMs: 1 }, [buffer]);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'focus', runId: 3, atMs: 1 }, [buffer]);
    const reply: WorkerToMain = { type: 'error', runId: 3, message: 'x' };
    fire('message', { data: reply });
    expect(got).toEqual([reply]);
  });

  it('turns worker failures into error messages for the current run', () => {
    const { worker, fire } = fakeWorker();
    const t = fromWorker(worker);
    const got: WorkerToMain[] = [];
    t.onMessage((m) => got.push(m));
    t.postMessage({ type: 'focus', runId: 4, atMs: 1 });
    fire('error', { message: 'failed to load' });
    fire('messageerror', {});
    expect(got).toEqual([
      { type: 'error', runId: 4, message: 'Engine worker error: failed to load' },
      { type: 'error', runId: 4, message: 'Engine worker message error' },
    ]);
  });

  it('unsubscribes and terminates', () => {
    const { worker, fire, listeners } = fakeWorker();
    const t = fromWorker(worker);
    const handler = vi.fn();
    const off = t.onMessage(handler);
    off();
    fire('message', { data: {} });
    expect(handler).not.toHaveBeenCalled();
    t.terminate();
    expect(worker.terminate).toHaveBeenCalled();
    expect(listeners.get('message')!.size).toBe(0);
  });
});
