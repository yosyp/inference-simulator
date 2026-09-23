// The engine typechecks against ES2023 only (no DOM or WebWorker types), so it can't touch browser
// APIs. structuredClone is the one host global it needs: it exists in every browser, worker, and
// Node 17+ runtime, and checkpoints depend on it (04-stack §3).
declare function structuredClone<T>(value: T): T;
