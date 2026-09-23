// The real engine worker. Only the app entry (X1) imports this file; tests use fake-transport.ts.
//
// The worker file belongs to E11. Until it exists, importing this module from the app graph makes
// `vite build` fail ("could not resolve ../worker/engine.worker.ts"), so nothing imports it yet.
// The call stays in the literal form Vite needs to bundle the worker as a separate file under the
// production CSP (`worker-src 'self'`; never inline or blob:, 04-stack §3).

import { fromWorker, type EngineTransport } from './transport.ts';

export function createWorkerTransport(): EngineTransport {
  return fromWorker(
    new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' }),
  );
}
