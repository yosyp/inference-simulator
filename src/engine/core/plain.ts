// Plain-data helpers: a checker for "state must survive structuredClone" (CLAUDE.md), a stable
// digest for comparing runs, and canonical JSON for fingerprints. Test and tooling helpers; the
// hot loop never calls them.

/** Throws, naming the path, if `value` holds anything structuredClone would not round-trip. */
export function assertPlainData(value: unknown, path = 'state'): void {
  walkPlain(value, path, new Set());
}

function walkPlain(v: unknown, path: string, seen: Set<object>): void {
  const t = typeof v;
  if (v === null || t === 'undefined' || t === 'boolean' || t === 'string' || t === 'bigint') {
    return;
  }
  if (t === 'number') return;
  if (t === 'function') throw new Error(`${path} is a function; state must be plain data`);
  if (t === 'symbol') throw new Error(`${path} is a symbol; state must be plain data`);
  const obj = v as object;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return;
  const proto = Object.getPrototypeOf(obj) as unknown;
  if (Array.isArray(obj) && proto === Array.prototype) {
    for (let i = 0; i < obj.length; i++) walkPlain(obj[i], `${path}[${i}]`, seen);
    return;
  }
  if (obj instanceof Map && proto === Map.prototype) {
    for (const [k, x] of obj) {
      walkPlain(k, `${path}.key(${String(k)})`, seen);
      walkPlain(x, `${path}.get(${String(k)})`, seen);
    }
    return;
  }
  if (obj instanceof Set && proto === Set.prototype) {
    for (const x of obj) walkPlain(x, `${path}.has(${String(x)})`, seen);
    return;
  }
  if (proto !== Object.prototype && proto !== null) {
    const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
    throw new Error(`${path} is a ${name} instance; state must be plain data`);
  }
  for (const key of Object.keys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key)!;
    if (d.get || d.set) throw new Error(`${path}.${key} is an accessor; state must be plain data`);
    walkPlain(d.value, `${path}.${key}`, seen);
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new Error(`${path} has symbol keys; structuredClone drops them`);
  }
}

// Two 32-bit FNV-1a-style lanes with different seeds; 64 bits is plenty to compare runs.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Hasher {
  h1 = 0x811c9dc5;
  h2 = 0x01000193 ^ 0x5bd1e995;
  word(x: number): void {
    this.h1 = Math.imul(this.h1 ^ (x >>> 0), 0x01000193);
    this.h2 = Math.imul(this.h2 ^ (x >>> 0), 0x5bd1e995) ^ (this.h2 >>> 15);
  }
  num(x: number): void {
    f64[0] = x;
    this.word(u32[0]!);
    this.word(u32[1]!);
  }
  str(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }
  hex(): string {
    return (
      (this.h1 >>> 0).toString(16).padStart(8, '0') + (this.h2 >>> 0).toString(16).padStart(8, '0')
    );
  }
}

/**
 * A stable 64-bit digest of plain data: object keys sorted, arrays by element, typed arrays by
 * type and every element, Maps and Sets in insertion order. Equal digests mean equal state for
 * practical purposes. Not a security hash.
 */
export function digestState(value: unknown): string {
  const h = new Hasher();
  digestInto(h, value);
  return h.hex();
}

function digestInto(h: Hasher, v: unknown): void {
  if (v === null) return h.word(1);
  switch (typeof v) {
    case 'undefined':
      return h.word(2);
    case 'boolean':
      return h.word(v ? 3 : 4);
    case 'number':
      h.word(5);
      return h.num(v);
    case 'string':
      h.word(6);
      return h.str(v);
    case 'bigint':
      h.word(7);
      return h.str(v.toString());
    case 'object':
      break;
    default:
      throw new Error(`digestState: ${typeof v} is not plain data`);
  }
  const obj = v as object;
  if (ArrayBuffer.isView(obj)) {
    const arr = obj as unknown as ArrayLike<number | bigint>;
    h.word(8);
    h.str(obj.constructor.name);
    h.word(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i]!;
      if (typeof x === 'bigint') h.str(x.toString());
      else h.num(x);
    }
    return;
  }
  if (Array.isArray(obj)) {
    h.word(9);
    h.word(obj.length);
    for (const x of obj) digestInto(h, x);
    return;
  }
  if (obj instanceof Map) {
    h.word(10);
    h.word(obj.size);
    for (const [k, x] of obj) {
      digestInto(h, k);
      digestInto(h, x);
    }
    return;
  }
  if (obj instanceof Set) {
    h.word(11);
    h.word(obj.size);
    for (const x of obj) digestInto(h, x);
    return;
  }
  h.word(12);
  const keys = Object.keys(obj).sort();
  h.word(keys.length);
  for (const k of keys) {
    h.str(k);
    digestInto(h, (obj as Record<string, unknown>)[k]);
  }
}

/** JSON with object keys sorted, so equal plain data gives equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}
