// Content keys for KV blocks (02 §7 rule 5, §8 session history). vLLM hashes each full block's
// tokens, chained on the previous block's hash. The simulator has no tokens, so a key names the
// content directly:
//
// - Blocks that lie wholly inside the shared system prompt are keyed by block index alone, so every
//   session shares them. The system prompt is treated as one fixed text cut at the configured
//   length, so two lengths share their common full blocks.
// - Every other block is keyed by (day-local session id, block index). A session's sequence only
//   grows: turn N+1's prompt is turn N's prompt and output plus a new message, so block i of the
//   session holds the same tokens in every turn. The block that straddles the end of the system
//   prompt holds session tokens too, so it is a session block.
//
// key = owner × KEY_BLOCK_SPAN + blockIndex, with owner 0 for the system prompt and session + 1 for
// a session. The largest key is below 2^53, so keys are exact in a number and a Float64Array.

import type { SessionId } from '../api.ts';

/** Marks a block with no content key: free, or a private (partial or duplicate) block. */
export const NO_KEY = -1;

/** Block indices a key can address: 2^20, i.e. 16M-token sequences at block size 16. */
export const KEY_BLOCK_SPAN = 1_048_576;

/** Largest session id a key can carry (uint32). */
export const MAX_KEY_SESSION = 0xffff_ffff;

function checkBlockIndex(blockIndex: number): void {
  if (!(blockIndex >= 0 && blockIndex < KEY_BLOCK_SPAN && Number.isInteger(blockIndex))) {
    throw blockIndexError(blockIndex);
  }
}

// Errors are built out of line so the key functions stay small enough for V8 to inline.

function blockIndexError(blockIndex: number): RangeError {
  return new RangeError(`KV block index ${blockIndex} is outside [0, ${KEY_BLOCK_SPAN})`);
}

function sessionKeyError(session: SessionId, blockIndex: number): RangeError {
  if (!(session >= 0 && session <= MAX_KEY_SESSION && Number.isInteger(session))) {
    return new RangeError(`Session id ${session} is outside [0, ${MAX_KEY_SESSION}]`);
  }
  return blockIndexError(blockIndex);
}

/** Key of block `blockIndex` of the shared system prompt. */
export function systemBlockKey(blockIndex: number): number {
  checkBlockIndex(blockIndex);
  return blockIndex;
}

/** Key of block `blockIndex` of a session's sequence (history, new message, and output). */
export function sessionBlockKey(session: SessionId, blockIndex: number): number {
  // x >>> 0 === x holds exactly for the integers 0 .. 2^32 − 1 (MAX_KEY_SESSION).
  if (
    session >>> 0 !== session ||
    blockIndex >>> 0 !== blockIndex ||
    blockIndex >= KEY_BLOCK_SPAN
  ) {
    throw sessionKeyError(session, blockIndex);
  }
  return (session + 1) * KEY_BLOCK_SPAN + blockIndex;
}

/**
 * Key of block `blockIndex` of a session's sequence, where the first `systemBlocks` blocks are the
 * shared system prompt's full blocks (floor(systemPromptTokens / blockSize)).
 */
export function sequenceBlockKey(
  systemBlocks: number,
  session: SessionId,
  blockIndex: number,
): number {
  return blockIndex < systemBlocks
    ? systemBlockKey(blockIndex)
    : sessionBlockKey(session, blockIndex);
}

export function isSystemKey(key: number): boolean {
  return key >= 0 && key < KEY_BLOCK_SPAN;
}

/** The session a key belongs to, or -1 for a shared system-prompt block. */
export function keySession(key: number): SessionId {
  return Math.floor(key / KEY_BLOCK_SPAN) - 1;
}

/** The block index within its sequence. */
export function keyBlockIndex(key: number): number {
  return key % KEY_BLOCK_SPAN;
}
