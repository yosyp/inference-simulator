// The engine client's link to the engine (00-build U2): one interface over two backends, the real
// Web Worker (worker-transport.ts) and a fixture-backed fake (fake-transport.ts).

import type { MainToWorker, WorkerToMain } from '../worker/protocol.ts';

export interface EngineTransport {
  postMessage(msg: MainToWorker, transfer?: Transferable[]): void;
  /** Registers a handler for worker messages; returns an unsubscribe function. */
  onMessage(handler: (msg: WorkerToMain) => void): () => void;
  terminate(): void;
}

/** The subset of Worker that fromWorker needs, so tests can pass a stand-in. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  terminate(): void;
}

/**
 * Adapts a Worker to EngineTransport. Worker-level failures (the script failed to load, a message
 * could not be deserialized) arrive as protocol 'error' messages under the last runId sent, so the
 * store reports them like engine errors.
 */
export function fromWorker(worker: WorkerLike): EngineTransport {
  const handlers = new Set<(msg: WorkerToMain) => void>();
  let lastRunId = 0;
  const dispatch = (msg: WorkerToMain) => {
    for (const h of [...handlers]) h(msg);
  };
  const onMessage = (e: MessageEvent) => dispatch(e.data as WorkerToMain);
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', (e: ErrorEvent) =>
    dispatch({ type: 'error', runId: lastRunId, message: `Engine worker error: ${e.message}` }),
  );
  worker.addEventListener('messageerror', () =>
    dispatch({ type: 'error', runId: lastRunId, message: 'Engine worker message error' }),
  );
  return {
    postMessage(msg, transfer = []) {
      lastRunId = msg.runId;
      worker.postMessage(msg, transfer);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    terminate() {
      handlers.clear();
      worker.removeEventListener('message', onMessage);
      worker.terminate();
    },
  };
}
