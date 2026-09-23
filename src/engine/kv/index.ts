// KV block manager and prefix cache (WP E4; 02 §7 rules 3 and 5). One KvPool per replica.
//
// How a request uses it (E5 scheduler, E10 oracle). `r.blocks` is the request's block table
// (sequence block i at index i), `r.held` how many blocks it holds, `r.registered` how many leading
// blocks have been through registration, `L` the tokens it must hold (prompt, plus output so far
// after a preemption), `S` its system prompt length, `s` its session.
//
//   Admit (waiting → running):
//     hits = longestCachedPrefix(pool, s, S, L, r.blocks, 0)          // cached = hits × blockSize
//     if (!canAcquire(pool, r.blocks, 0, hits, blocksForTokens(pool, L) - hits)) keep waiting
//     acquireBlocks(pool, r.blocks, 0, hits, blocksForTokens(pool, cached + chunk) - hits)
//     r.held = hits + that; r.registered = hits
//     Do the lookup and the acquire with no allocation or release between them.
//   Grow (next chunk, or a decode step that crosses a block boundary):
//     allocateBlocks(pool, need, r.blocks, r.held) || preempt (02 §7 rule 4)
//   After tokens are computed (their KV exists), and before any release:
//     r.registered = registerFullBlocks(pool, s, S, r.blocks, 0, r.registered, computedTokens)
//     A finished request's last output token was never fed back, so its KV is P + O − 1 tokens.
//     Registration needs the blocks still held; unregistered full blocks are lost on release.
//   Finish, abort, or preempt (register first, so the blocks stay cached):
//     releaseBlocks(pool, r.blocks, 0, r.held); r.held = 0; r.registered = 0
//   After any acquireBlocks / allocateBlocks:
//     pool.evictedKeys[0 .. pool.evictedCount) are the evicted contents (Evict events);
//     keySession(key) is the session that lost that block (-1 for the system prompt).
//   Crash: resetKvPool(pool) and drop every block table. Morning (K21): createMorningKvPool.

export { cachedBlock, cachedKeyCount } from './content.ts';
export {
  KEY_BLOCK_SPAN,
  MAX_KEY_SESSION,
  NO_KEY,
  isSystemKey,
  keyBlockIndex,
  keySession,
  sequenceBlockKey,
  sessionBlockKey,
  systemBlockKey,
} from './keys.ts';
export {
  type KvPool,
  type KvPoolConfig,
  assertKvInvariants,
  availableBlocks,
  blocksForTokens,
  createKvPool,
  createMorningKvPool,
  kvUsedFrac,
  lruOrder,
  resetKvPool,
  systemPromptBlocks,
} from './pool.ts';
export {
  type BlockOut,
  acquireBlocks,
  allocateBlocks,
  canAcquire,
  countEvictable,
  longestCachedPrefix,
  referenceBlocks,
  registerBlock,
  registerFullBlocks,
  releaseBlocks,
} from './ops.ts';
