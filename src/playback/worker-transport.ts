// The real engine worker (E11). Only the app entry imports this file; tests use fake-transport.ts.
// The call stays in the literal form Vite needs to bundle the worker as a separate file under the
// production CSP (`worker-src 'self'`; never inline or blob:, 04-stack §3).

import { fromWorker, type EngineTransport } from './transport.ts';

export function createWorkerTransport(): EngineTransport {
  return fromWorker(
    new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' }),
  );
}
