import { describe, expect, it } from 'vitest';
import {
  KEY_BLOCK_SPAN,
  MAX_KEY_SESSION,
  isSystemKey,
  keyBlockIndex,
  keySession,
  sequenceBlockKey,
  sessionBlockKey,
  systemBlockKey,
} from './keys.ts';

describe('KV content keys', () => {
  it('round-trips session and block index', () => {
    for (const session of [0, 1, 7, 123_456, MAX_KEY_SESSION]) {
      for (const block of [0, 1, 999, KEY_BLOCK_SPAN - 1]) {
        const key = sessionBlockKey(session, block);
        expect(Number.isSafeInteger(key)).toBe(true);
        expect(keySession(key)).toBe(session);
        expect(keyBlockIndex(key)).toBe(block);
        expect(isSystemKey(key)).toBe(false);
      }
    }
  });

  it('keys system-prompt blocks by index alone, shared by every session', () => {
    expect(systemBlockKey(0)).toBe(0);
    expect(systemBlockKey(41)).toBe(41);
    expect(keySession(systemBlockKey(41))).toBe(-1);
    expect(keyBlockIndex(systemBlockKey(41))).toBe(41);
    expect(isSystemKey(systemBlockKey(41))).toBe(true);
    expect(sequenceBlockKey(3, 10, 2)).toBe(sequenceBlockKey(3, 99, 2));
  });

  it('gives the block straddling the end of the system prompt to the session', () => {
    // 3 full system blocks: block 3 holds the prompt's last tokens and the session's first.
    expect(sequenceBlockKey(3, 10, 3)).toBe(sessionBlockKey(10, 3));
    expect(sequenceBlockKey(3, 10, 3)).not.toBe(sequenceBlockKey(3, 11, 3));
  });

  it('never collides across owners or indices', () => {
    const seen = new Set<number>();
    for (let b = 0; b < 50; b++) seen.add(systemBlockKey(b));
    for (let s = 0; s < 50; s++) for (let b = 0; b < 50; b++) seen.add(sessionBlockKey(s, b));
    expect(seen.size).toBe(50 + 50 * 50);
  });

  it('stays a safe integer at the largest session and index', () => {
    const key = sessionBlockKey(MAX_KEY_SESSION, KEY_BLOCK_SPAN - 1);
    expect(key).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(new Float64Array([key])[0]).toBe(key);
  });

  it('rejects ids and indices outside the encodable range', () => {
    expect(() => sessionBlockKey(-1, 0)).toThrow(RangeError);
    expect(() => sessionBlockKey(MAX_KEY_SESSION + 1, 0)).toThrow(RangeError);
    expect(() => sessionBlockKey(1.5, 0)).toThrow(RangeError);
    expect(() => sessionBlockKey(0, KEY_BLOCK_SPAN)).toThrow(RangeError);
    expect(() => systemBlockKey(-1)).toThrow(RangeError);
  });
});
