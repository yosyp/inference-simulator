import { describe, expect, it } from 'vitest';
import { assertPlainData, canonicalJson, digestState } from './plain.ts';

describe('assertPlainData', () => {
  it('accepts objects, arrays, typed arrays, Maps, Sets, and shared references', () => {
    const shared = { x: 1 };
    const ok = {
      a: [1, 'two', null, undefined, true, 3n],
      t: new Float64Array(3),
      m: new Map([[1, { y: new Uint8Array(2) }]]),
      s: new Set([1, 2]),
      p: shared,
      q: shared,
      n: Object.create(null) as object,
    };
    expect(() => assertPlainData(ok)).not.toThrow();
  });

  it('names the path of a function, class instance, accessor, or symbol', () => {
    class Box {}
    expect(() => assertPlainData({ a: [{ f: () => 1 }] })).toThrow(
      /state\.a\[0\]\.f is a function/,
    );
    expect(() => assertPlainData({ b: new Box() })).toThrow(/state\.b is a Box instance/);
    const withGetter = {
      get g() {
        return 1;
      },
    };
    expect(() => assertPlainData({ c: withGetter })).toThrow(/state\.c\.g is an accessor/);
    expect(() => assertPlainData({ d: Symbol('s') })).toThrow(/symbol/);
    expect(() => assertPlainData({ m: new Map([[1, () => 0]]) })).toThrow(/is a function/);
  });
});

describe('digestState', () => {
  it('is stable across key order and clones, and sensitive to values and types', () => {
    const a = { x: 1, y: [1, 2, { z: new Float64Array([0.5, -0]) }], m: new Map([['k', 1]]) };
    const b = { y: [1, 2, { z: new Float64Array([0.5, -0]) }], m: new Map([['k', 1]]), x: 1 };
    expect(digestState(a)).toBe(digestState(b));
    expect(digestState(structuredClone(a))).toBe(digestState(a));
    expect(digestState({ ...a, x: 2 })).not.toBe(digestState(a));
    expect(digestState({ t: new Float32Array([1]) })).not.toBe(
      digestState({ t: new Float64Array([1]) }),
    );
    expect(digestState([1, [2]])).not.toBe(digestState([[1], 2]));
    expect(digestState({ a: undefined })).not.toBe(digestState({}));
    expect(digestState('ab')).not.toBe(digestState('ba'));
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ f: 1, e: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[{"e":2,"f":1}]},"b":1}',
    );
  });
});
