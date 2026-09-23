// The engine Web Worker entry (04 §3). U2's worker-transport.ts loads this file with
// new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' }), which
// Vite bundles as a separate asset (never inline or blob:, per the production CSP).
// All logic lives in host.ts; this file only binds it to the worker scope.

import { createEngineHost } from './host.ts';
import type { MainToWorker } from './protocol.ts';
import { macrotaskScheduler } from './scheduler.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const host = createEngineHost({
  post: (msg, transfer) => scope.postMessage(msg, transfer),
  schedule: macrotaskScheduler().schedule,
});

scope.addEventListener('message', (e: MessageEvent<MainToWorker>) => host.handle(e.data));
