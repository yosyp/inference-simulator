// Shared numbering for event kinds, priorities, and notice topics (see README.md).
// Numbers, not strings, so the queue stores them in typed arrays and dispatch is an array lookup.

/** Event kinds and topics are integers in [1, MAX_KIND). 0 is reserved (PATCH_KIND in traces). */
export const MAX_KIND = 1024;
export const MAX_TOPIC = 1024;
/** Kind reported to RunnerOptions.trace for a patch applied by the core. */
export const PATCH_KIND = 0;

/**
 * Each module picks its event kinds and topics from its own range, so parallel WPs never collide.
 * The runner rejects duplicate kinds when it is built.
 */
export const KIND_RANGES = {
  core: [1, 99],
  load: [100, 199], // E6 load generator and client
  router: [200, 299], // E7
  replica: [300, 399], // E5 replica scheduler
  failure: [400, 499], // E8
  metrics: [500, 599], // E9
  spare: [600, 899],
  test: [900, 1023], // toy models in tests
} as const satisfies Record<string, readonly [number, number]>;

/**
 * Priority bands: at equal atMs, lower priority fires first; within a kind, push order decides.
 * A module may use band + 0..9 to order its own kinds. Patches are applied before every event at
 * their instant (they are not queued; see README "Patches").
 *
 * Rationale for the order, all at the same instant:
 * - infra: a crash or Ready changes which replicas exist before any request event sees them.
 * - engine: completions and first tokens land before timeouts, so a first token exactly at the
 *   deadline counts (K8: "no token has arrived by then"), and freed capacity is visible to arrivals.
 * - client: timeouts, then router signal refresh, then new arrivals and retries.
 * - late: observation that must see the instant settled.
 */
export const PRIORITY = {
  infra: 10, // E8: crash, mark-down, load phases, Ready
  engine: 20, // E5: step-span ends (first token, finish, prefill chunk, KV exhaustion)
  client: 30, // E6: client timeouts
  router: 40, // E7: signal refresh, dispatch after router overhead
  arrival: 50, // E6: session start, next turn, retry
  late: 90,
} as const;

/**
 * Shared request-lifecycle topics (02 §3). Subscribers run synchronously, in module order, when a
 * module calls ctx.notify(topic, a, b). Payloads are two numbers.
 */
export const TOPIC = {
  /** A request produced its first output token. a = RequestId, b = ReplicaId. Emitted by E5. */
  firstToken: 1,
  /**
   * A request reached its outcome; emitted once per request by the module that ends it.
   * a = RequestId, b = OUTCOME code from results.ts (finished, rejected, timedOut, failed).
   */
  requestEnded: 2,
  /** A replica changed state. a = ReplicaId, b = REPLICA_STATE code from results.ts. Emitted by E8. */
  replicaState: 3,
} as const;
