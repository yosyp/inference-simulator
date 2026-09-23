// Differential oracle (WP E10; 00-build §7.2). A second, deliberately plain simulator of the
// per-replica rules (02 §7, K32) that ticks every engine step, has no event-jumping and no lazy
// state, and shares only E3's cost model and E4's KV pool with the engine (plus E7's pure routing
// helpers, since routing is not what's under test). Tests only: nothing in the app imports it.
//
// Files:
//   scheduler.ts  the oracle's replica: compose a step, apply it, enqueue, cancel, crash
//   sim.ts        the day loop: scripted client, router (E7 helpers), replicas; runOracle
//   engine-run.ts the real engine on the same input: shared, client driver, E7, E5, E9; runEngine
//   workload.ts   oracleWorkload(seed, cal): E5's randomWorkload plus E10's keyed extensions
//   compare.ts    per-request, meter, and final-pool comparison; first diverging event and step
//   differential.ts checkSeed, and explain() for a readable failure report
//
// Per request the check compares first-token and finish times (as offsets from arrival, ≤ 1e-6
// relative), outcome, replica, preemptions, cached tokens, output done, and every state change;
// per replica, the day's meter totals and the final KV pool contents (evictable keys in LRU order,
// free and referenced counts, evictions), which is where a same-step ordering difference shows
// first. It does not cover E6's real load generator (retries, backoff, abandonment), E8, E9's
// chunks and histograms, meters at bucket boundaries, checkpoints, or patches; and it cannot see
// bugs in E3, E4, or E7's policy helpers, which both sides share.

export {
  checkInput,
  checkSeed,
  compareAll,
  describeInput,
  explain,
  type SeedCheck,
} from './differential.ts';
export { runEngine, type EngineRunOptions } from './engine-run.ts';
export { engineLimitsOf, runOracle, type OracleOptions } from './sim.ts';
export type { OracleInput, OracleReplicaChange, OracleRequestSpec, RunResults } from './types.ts';
export { MAX_REQUESTS, oracleWorkload } from './workload.ts';
