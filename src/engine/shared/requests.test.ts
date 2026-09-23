import { describe, expect, it } from 'vitest';
import { OUTCOME, REQUEST_STATE } from '../results.ts';
import {
  allocRequest,
  assertRequestTable,
  createRequestTable,
  isLive,
  releaseRequest,
} from './requests.ts';

describe('request table', () => {
  it('assigns increasing ids and starts requests at the router', () => {
    const t = createRequestTable(2);
    const a = allocRequest(t);
    const b = allocRequest(t);
    expect([t.id[a], t.id[b]]).toEqual([0, 1]);
    expect(t.state[a]).toBe(REQUEST_STATE.atRouter);
    expect(t.replica[a]).toBe(-1);
    expect(t.arriveMs[a]).toBeNaN();
  });

  it('grows and keeps field values', () => {
    const t = createRequestTable(2);
    const slots = Array.from({ length: 5 }, () => allocRequest(t));
    t.promptTokens[slots[1]!] = 1234;
    allocRequest(t);
    expect(t.capacity).toBeGreaterThanOrEqual(6);
    expect(t.promptTokens[slots[1]!]).toBe(1234);
    assertRequestTable(t);
  });

  it('reuses a released slot only at the next allocation, cleared', () => {
    const t = createRequestTable(1);
    const a = allocRequest(t);
    t.outcome[a] = OUTCOME.finished;
    releaseRequest(t, a);
    expect(t.outcome[a]).toBe(OUTCOME.finished); // still readable by later subscribers
    expect(isLive(t, a)).toBe(false);
    const b = allocRequest(t);
    expect(b).toBe(a);
    expect(t.outcome[b]).toBe(0);
    expect(t.id[b]).toBe(1);
    assertRequestTable(t);
  });

  it('survives structuredClone', () => {
    const t = createRequestTable(4);
    allocRequest(t);
    const c = structuredClone(t);
    expect(allocRequest(c)).toBe(allocRequest(t));
  });

  it('rejects a double release', () => {
    const t = createRequestTable(1);
    const a = allocRequest(t);
    releaseRequest(t, a);
    expect(() => releaseRequest(t, a)).toThrow();
  });
});
