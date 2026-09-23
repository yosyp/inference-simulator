// Replica scheduler (WP E5; 02 §3-§7). One vLLM V1-style engine per replica, over E4's KV pool and
// E3's cost model, with event-jumping over decode-only spans. Module order: after the router (E7).
//
// Inputs (topics, core/ids.ts):
// - requestDispatched (a = slot, b = replica): the request joins the waiting queue (state waiting).
//   A replica that isn't Ready resets the connection: the request ends at once, OUTCOME.failed. So
//   does a request whose prompt + output exceeds maxModelLen or could never fit in the KV pool.
// - requestCancelled (a = slot): if held here, the request leaves at once (its blocks are
//   registered, then released) and ends OUTCOME.timedOut. The step in flight keeps its cost.
// - replicaState (a = replica, b = REPLICA_STATE): leaving Ready fails everything held
//   (OUTCOME.failed), wipes the pool, and stops stepping; returning to Ready starts from an empty
//   pool (createKvPool). Each day starts with every replica Ready and the system prompt cached.
//
// Outputs: requestState on every state change (waiting, prefill, decode, preempted, and the
// terminal state, which E9 ignores); firstToken (a = slot, b = replica); requestEnded. firstToken
// and requestEnded go out at firstTokenMs and endMs (= ctx.nowMs), never from onBucketEnd. E5
// writes firstTokenMs, cachedTokens (hits at the admission that produced the first token),
// outputDone, preemptions, and endMs/outcome/state for requests it ends. Meters: every
// ReplicaMeters counter plus the kvUsed, running, and waiting levels, exact at bucket ends
// (shared/meters.ts). Inside a span the pool and the kvUsed level are applied lazily: a module
// that reads them between bucket ends (the router's KV signal) calls syncReplica first, or uses
// replicaKvUsedFrac.
//
// A step, composed when the previous one ends (or at a kick when work reaches an idle replica,
// after the instant settles, so same-instant dispatches share the first step):
//   A. Decodes first: every decode-phase request computes one token. One crossing a block boundary
//      allocates a block, in admission order. If none is free or evictable, the most recently
//      admitted running request is preempted, repeatedly, until the allocation succeeds or the
//      request preempts itself.
//   B. Running requests still in prefill, in admission order, get chunks of min(remaining, budget)
//      from max_num_batched_tokens, allocating their blocks; a failed allocation preempts as in A
//      (a preempted decode returns its budget token). Once a request preempts itself, B stops.
//   C. Only if nothing was preempted in this step: admit from the waiting head while the running
//      set is below max_num_seqs and budget remains. The head is admitted when blocks for its whole
//      uncached prompt fit (E4 canAcquire; hits from longestCachedPrefix, at most prompt − 1
//      tokens); only its first chunk is allocated. The first head that doesn't fit stops admission.
//   Prefix counters count each admission (query = tokens looked up, hit = cached tokens); returning
//   counters the same for turn ≥ 2.
// At the step's end (E3 stepTime gives its length): registrations for blocks decodes filled;
// decodes that reached outputTarget finish (admission order); then each chunk registers its full
// blocks, and a chunk that completes the prefill samples a token — the first token unless the
// request is resuming after a preemption — then the request finishes (outputTarget reached) or
// decodes. Finished and removed requests register, then release, their blocks (E4 recipe).
// Preempted requests go to the front of the waiting queue (state preempted) and later prefill
// their prompt plus the output so far; prefill below what they had computed counts as recompute.
//
// Event-jumping (02 §5): a composed step that is decode-only, preempted nothing, and whose waiting
// head (if any) shares no session with a running request becomes a span of k steps in one event:
// k is the earlier of the next finish and the step whose block allocation would fail (then that
// step runs alone and preempts). Nothing can become admissible inside a span: running count and
// budget are fixed, blocks only get scarcer, and the head's cache hits only shrink. The span's
// allocations and registrations are applied lazily, step by step in exactly the per-step order,
// at bucket ends, at truncation, and at the span's end. An arrival that becomes the waiting head, a
// cancel of the head or of a running request, or a crash truncates the span: the step in flight
// finishes, then the scheduler replans. createReplicaModule({ eventJumping: false }) runs one
// event per step through the same code: the cross-check E10 and the tests use.
//
// Deliberate differences from vLLM V1, where 02 §7 decides: decodes go before running prefill
// chunks (vLLM walks running requests in admission order, so an earlier long prefill can starve
// later decodes); blocks are registered when their KV has been computed (vLLM caches at
// allocation); a preempted request's recompute counts toward prefix queries again.

export {
  createReplicaModule,
  replicaGeneratedTokens,
  replicaKvUsedFrac,
  replicaModule,
  replicaRunningCount,
  replicaStateCode,
  replicaWaitingCount,
  syncReplica,
  type ReplicaModuleOptions,
} from './module.ts';
export { EV_KICK, EV_STEP_END, MODE, PHASE, engineLimits, type EngineLimits } from './state.ts';
export type { ReplicaEngine, ReplicaSlice, RequestEngine } from './state.ts';
export type { StepInfo } from './steps.ts';
