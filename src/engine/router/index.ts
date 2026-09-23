// Router (WP E7; 02 §7; K9): admission control, five routing policies, delayed load signals, and
// the routable set. `routerModule` plugs into the day runner after the load module and before the
// replica module. See module.ts for the request path and the behaviour choices.
//
// The pure helpers are shared with tests and E10's oracle:
//   const ring = buildRing(seed, replicas, virtualNodesPerReplica);
//   const set = routableSet(replicas, [0, 1, 2]);
//   const target = affinityTarget(set, ring, 'consistent', sessionHash(seed, day, session));
//   const r = chooseReplica({ ...set, ring, seenOutstanding, seenKv, rrLast: -1 }, params, hash, tieU);

export {
  affinityTarget,
  buildRing,
  modNLookup,
  rebuildRoutableList,
  ringLookup,
  ringPosition,
  ringSuccessor,
  routableSet,
  sessionHash,
  type HashRing,
  type RoutableSet,
} from './hash.ts';
export {
  chooseReplica,
  maxSeenOutstanding,
  nextRoundRobin,
  pickLowest,
  pickWeighted,
  policyCanTie,
  policyUsesHash,
  weightedScore,
  type RoutingParams,
  type RoutingView,
} from './policies.ts';
export {
  EV_ROUTER_DISPATCH,
  EV_ROUTER_REFRESH,
  admissionCap,
  admittedCount,
  refreshSignals,
  routerModule,
  type RouterSlice,
  type RouterStats,
} from './module.ts';
export { assertRouterInvariants } from './invariants.ts';
