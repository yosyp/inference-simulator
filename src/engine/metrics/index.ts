// Metrics, results, and the High-side rollup (00-build E9; 02 §11; 01 §8).
//
//   createDayRunner([sharedModule, loadModule, routerModule, replicaModule, failureModule, metricsModule])
//   run.advance(t)          → ResultChunk (built by metricsModule.produceChunk)
//   dayRollup(run.state)    → RollupRow[] once run.done
//   inFlightTransitions(run.state, input) → rows that place in-flight requests at a detail window's start

export { metricsModule } from './module.ts';
export { dayRollup } from './rollup.ts';
export { inFlightTransitions } from './in-flight.ts';
export type { MetricsSlice } from './slice.ts';
