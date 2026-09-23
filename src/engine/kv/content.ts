// Content index: which block holds each cached content key (keys.ts). vLLM keeps a flat
// hash → block map. Here keys are grouped by owner (key ÷ KEY_BLOCK_SPAN: 0 for the system prompt,
// session + 1 for a session), and each owner's block indices are cut into pages of PAGE_SIZE
// consecutive indices. A page holds, for each of its indices, the block caching it plus one (0 when
// nothing is cached). An owner's pages form a doubly linked list in index order, and
// pool.contentIndex maps the owner to its first page. A page is freed as soon as it holds nothing,
// so the index stays proportional to the cached blocks.
//
// Every page lives in one typed array, pool.pages, PAGE_STRIDE entries each:
//   [live count, page number, next page + 1, previous page + 1, block + 1 per index…]
// where page number = block index ÷ PAGE_SIZE. A key's entry on its page is at key % PAGE_SIZE
// (KEY_BLOCK_SPAN is a multiple of PAGE_SIZE), and its page base, key − key % PAGE_SIZE, names the
// page: owner × KEY_BLOCK_SPAN + page number × PAGE_SIZE.
//
// - An eviction clears its entry without a lookup: pool.keyPage[b] is the page holding block b's.
// - A registration usually lands on the page of the latest index write (pool.hintPage, with base
//   pool.hintBase), which one comparison confirms. Otherwise the search starts from a page of the
//   same owner that the caller knows (the page of the block before it in the request's table), the
//   hint page, or the owner's first page.
// - A prefix walk is one Map.get per owner, then array reads, moving to the next page every
//   PAGE_SIZE blocks.
//
// Plain typed arrays keep checkpoints cheap: structuredClone copies them as bytes, where a Map of
// JS arrays is cloned element by element. They are Uint16Array while the pool has at most 65,535
// blocks, which bounds every value stored (block + 1, page + 1, page number < 2^14, count ≤ 64).

import { KEY_BLOCK_SPAN } from './keys.ts';
import type { KvPool } from './pool.ts';

/** Block indices per index page. */
export const PAGE_SIZE = 64;
const PAGE_SHIFT = 6;
const PAGE_MASK = PAGE_SIZE - 1;

// Offsets within a page.
const LIVE = 0;
const NUMBER = 1;
const NEXT = 2;
const PREV = 3;
const SLOTS = 4;
/** Entries per page in pool.pages. */
export const PAGE_STRIDE = SLOTS + PAGE_SIZE;

/** Pages a new or reset index has room for; the array doubles as needed, up to one per block. */
const INITIAL_PAGES = 8;

/** Ids plus one of blocks or pages, page numbers, and counts (see the file comment). */
export type IndexArray = Uint16Array | Int32Array;

export function indexArray(totalBlocks: number, length: number): IndexArray {
  return totalBlocks <= 0xffff ? new Uint16Array(length) : new Int32Array(length);
}

/** Storage for an empty index. */
export function emptyPages(totalBlocks: number): IndexArray {
  return indexArray(totalBlocks, Math.min(INITIAL_PAGES, totalBlocks) * PAGE_STRIDE);
}

/** Empty the index in place (pool.pages is replaced so a reset pool matches a new one). */
export function clearIndex(pool: KvPool): void {
  pool.contentIndex.clear();
  pool.pages = emptyPages(pool.totalBlocks);
  pool.pagesUsed = 0;
  pool.pageFree = 0;
  pool.keyPage.fill(0);
  pool.hintPage = -1;
  pool.hintBase = -1;
}

// ----- Pages -----

/**
 * Where to start looking for owner's page `number`: `from` if it is one of owner's pages (≥ 0);
 * else the hint page if it is owner's and not past `number`; else owner's first page. Returns -1
 * if owner has no pages.
 */
function startPage(pool: KvPool, owner: number, number: number, from: number): number {
  if (from >= 0) return from;
  const hint = pool.hintPage;
  if (
    hint >= 0 &&
    Math.floor(pool.hintBase / KEY_BLOCK_SPAN) === owner &&
    pool.pages[hint * PAGE_STRIDE + NUMBER]! <= number
  ) {
    return hint;
  }
  return pool.contentIndex.get(owner) ?? -1;
}

/**
 * Owner's page `number`, walking the list from startPage. If there is none: -1, or with `create`,
 * a new empty page linked in order. `from` as for startPage.
 */
function findPage(
  pool: KvPool,
  owner: number,
  number: number,
  from: number,
  create = false,
): number {
  let p = startPage(pool, owner, number, from);
  // The new page goes between `before` and `after` (-1 for none).
  let before = -1;
  let after = -1;
  if (p >= 0) {
    const d = pool.pages;
    if (d[p * PAGE_STRIDE + NUMBER]! <= number) {
      for (;;) {
        if (d[p * PAGE_STRIDE + NUMBER] === number) return p;
        const next = d[p * PAGE_STRIDE + NEXT]! - 1;
        if (next < 0 || d[next * PAGE_STRIDE + NUMBER]! > number) {
          before = p;
          after = next;
          break;
        }
        p = next;
      }
    } else {
      for (;;) {
        const prev = d[p * PAGE_STRIDE + PREV]! - 1;
        if (prev < 0 || d[prev * PAGE_STRIDE + NUMBER]! < number) {
          before = prev;
          after = p;
          break;
        }
        p = prev;
        if (d[p * PAGE_STRIDE + NUMBER] === number) return p;
      }
    }
  }
  return create ? addPage(pool, owner, number, before, after) : -1;
}

function allocPage(pool: KvPool): number {
  if (pool.pageFree !== 0) {
    const p = pool.pageFree - 1;
    pool.pageFree = pool.pages[p * PAGE_STRIDE + NEXT]!;
    pool.pages[p * PAGE_STRIDE + NEXT] = 0;
    return p;
  }
  const capacity = pool.pages.length / PAGE_STRIDE;
  if (pool.pagesUsed === capacity) {
    // Every page in use holds a cached block, so there are never more pages than blocks. Grown by
    // half, not doubled: the unused tail is copied into every checkpoint.
    if (capacity >= pool.totalBlocks) throw new Error('KV content index is out of pages');
    const grown = indexArray(
      pool.totalBlocks,
      Math.min(pool.totalBlocks, capacity + Math.max(INITIAL_PAGES, capacity >> 1)) * PAGE_STRIDE,
    );
    grown.set(pool.pages);
    pool.pages = grown;
  }
  return pool.pagesUsed++;
}

/** A new empty page `number` for owner, linked between pages `before` and `after` (-1: none). */
function addPage(
  pool: KvPool,
  owner: number,
  number: number,
  before: number,
  after: number,
): number {
  const q = allocPage(pool);
  const d = pool.pages; // allocPage may have grown it
  const base = q * PAGE_STRIDE;
  d[base + LIVE] = 0;
  d[base + NUMBER] = number;
  d[base + NEXT] = after + 1;
  d[base + PREV] = before + 1;
  if (before >= 0) d[before * PAGE_STRIDE + NEXT] = q + 1;
  else pool.contentIndex.set(owner, q);
  if (after >= 0) d[after * PAGE_STRIDE + PREV] = q + 1;
  return q;
}

// Unlink an empty page from its owner's list (`key` is any key of the owner's) and free it.
function freePage(pool: KvPool, page: number, key: number): void {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  const d = pool.pages;
  const base = page * PAGE_STRIDE;
  const next = d[base + NEXT]!;
  const prev = d[base + PREV]!;
  if (prev !== 0) d[(prev - 1) * PAGE_STRIDE + NEXT] = next;
  else if (next !== 0) pool.contentIndex.set(owner, next - 1);
  else pool.contentIndex.delete(owner);
  if (next !== 0) d[(next - 1) * PAGE_STRIDE + PREV] = prev;
  d[base + NUMBER] = 0;
  d[base + PREV] = 0;
  d[base + NEXT] = pool.pageFree;
  pool.pageFree = page + 1;
  if (pool.hintPage === page) {
    pool.hintPage = -1;
    pool.hintBase = -1;
  }
}

// ----- Keys -----

/** The block caching this content key, or -1. */
export function cachedBlock(pool: KvPool, key: number): number {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  const page = findPage(pool, owner, (key - owner * KEY_BLOCK_SPAN) >>> PAGE_SHIFT, -1);
  return page < 0 ? -1 : pool.pages[page * PAGE_STRIDE + SLOTS + (key & PAGE_MASK)]! - 1;
}

/**
 * Record `block` as holding `key` and return -1, or, if another block already holds `key`, change
 * nothing and return that block. `from` is a page of the key's owner to search from, or -1 (see
 * startPage).
 */
export function indexAdd(pool: KvPool, key: number, block: number, from: number): number {
  const slot = key & PAGE_MASK;
  const page = key - slot === pool.hintBase ? pool.hintPage : searchPage(pool, key, from);
  const at = page * PAGE_STRIDE;
  const d = pool.pages;
  const holder = d[at + SLOTS + slot]! - 1;
  if (holder >= 0) return holder;
  d[at + SLOTS + slot] = block + 1;
  d[at + LIVE]!++;
  pool.keyPage[block] = page;
  if (page !== pool.hintPage) setHint(pool, page, key);
  return -1;
}

// The page for `key`, created if missing.
function searchPage(pool: KvPool, key: number, from: number): number {
  const owner = Math.floor(key / KEY_BLOCK_SPAN);
  return findPage(pool, owner, (key - owner * KEY_BLOCK_SPAN) >>> PAGE_SHIFT, from, true);
}

function setHint(pool: KvPool, page: number, key: number): void {
  pool.hintPage = page;
  pool.hintBase = key - (key & PAGE_MASK);
}

/** Record `block` as holding `key` in place of `holder`, the block that holds it (a duplicate). */
export function indexReplace(pool: KvPool, holder: number, key: number, block: number): void {
  const page = pool.keyPage[holder]!;
  pool.pages[page * PAGE_STRIDE + SLOTS + (key & PAGE_MASK)] = block + 1;
  pool.keyPage[block] = page;
  setHint(pool, page, key);
}

/** The block `page` records as holding `key`, or -1 (for checks: the page must be `key`'s). */
export function indexHolder(pool: KvPool, page: number, key: number): number {
  return pool.pages[page * PAGE_STRIDE + SLOTS + (key & PAGE_MASK)]! - 1;
}

/** Forget the content key `block` caches (read from pool.contentKey, which the caller clears). */
export function indexRemove(pool: KvPool, block: number): void {
  const key = pool.contentKey[block]!;
  const page = pool.keyPage[block]!;
  const at = page * PAGE_STRIDE;
  const d = pool.pages;
  d[at + SLOTS + (key & PAGE_MASK)] = 0;
  if (--d[at + LIVE]! === 0) freePage(pool, page, key);
}

// ----- Lookups -----

/**
 * Walk owner's cached block indices from, from + 1, … up to `to` (exclusive), writing index i's
 * block to out[outOffset + i]. Returns the first index not cached, or `to`.
 */
export function walkCached(
  pool: KvPool,
  owner: number,
  from: number,
  to: number,
  out: Int32Array | number[],
  outOffset: number,
): number {
  if (from >= to) return from;
  const d = pool.pages;
  // A prefix walk starts at or after the owner's first page: step forward to from's page.
  const first = from >>> PAGE_SHIFT;
  let page = pool.contentIndex.get(owner) ?? -1;
  while (page >= 0 && d[page * PAGE_STRIDE + NUMBER]! < first) {
    page = d[page * PAGE_STRIDE + NEXT]! - 1;
  }
  if (page < 0 || d[page * PAGE_STRIDE + NUMBER] !== first) return from;
  let n = from;
  let pageStart = first * PAGE_SIZE;
  for (;;) {
    // Entries i .. stop of `d` hold block indices n .. on this page; out[i + shift] gets them.
    const at = page * PAGE_STRIDE + SLOTS - pageStart;
    const stop = at + (to < pageStart + PAGE_SIZE ? to : pageStart + PAGE_SIZE);
    const shift = outOffset - at;
    let i = at + n;
    for (; i < stop; i++) {
      const entry = d[i]!;
      if (entry === 0) break;
      out[i + shift] = entry - 1;
    }
    n = i - at;
    if (i < stop || n === to) return n;
    page = d[page * PAGE_STRIDE + NEXT]! - 1;
    pageStart += PAGE_SIZE;
    if (page < 0 || d[page * PAGE_STRIDE + NUMBER] !== pageStart >>> PAGE_SHIFT) return n;
  }
}

/** Number of cached content keys (allocates nothing; O(pages)). */
export function cachedKeyCount(pool: KvPool): number {
  const d = pool.pages;
  let n = 0;
  for (let p = 0; p < pool.pagesUsed; p++) n += d[p * PAGE_STRIDE + LIVE]!;
  return n;
}

// ----- Invariants -----

/**
 * Checks the index against pool.contentKey (for assertKvInvariants): every owner's pages are in
 * order and consistent, every entry points at a block with that key, and every page is either in
 * exactly one owner's list or on the free list. Returns the number of entries.
 */
export function checkIndex(pool: KvPool, check: (ok: boolean, message: string) => void): number {
  const d = pool.pages;
  const n = pool.totalBlocks;
  const capacity = d.length / PAGE_STRIDE;
  check(Number.isInteger(capacity) && capacity <= n, `index has room for ${capacity} pages`);
  check(pool.pagesUsed >= 0 && pool.pagesUsed <= capacity, `pagesUsed ${pool.pagesUsed}`);
  // Page base (see the file comment) + 1 of each page in a list, -1 for a free page.
  const pageBase = new Float64Array(pool.pagesUsed);
  let entries = 0;
  for (const [owner, first] of pool.contentIndex) {
    check(Number.isSafeInteger(owner) && owner >= 0, `index owner ${owner}`);
    let prev = -1;
    let lastNumber = -1;
    for (let p = first; p >= 0; prev = p, p = d[p * PAGE_STRIDE + NEXT]! - 1) {
      check(p < pool.pagesUsed, `owner ${owner} links to page ${p}`);
      check(pageBase[p] === 0, `page ${p} is in two lists, or a list has a cycle`);
      const base = p * PAGE_STRIDE;
      check(d[base + PREV] === prev + 1, `page ${p} links back to ${d[base + PREV]! - 1}`);
      const number = d[base + NUMBER]!;
      check(number > lastNumber, `owner ${owner}'s pages are out of order at ${p}`);
      lastNumber = number;
      const keyBase = owner * KEY_BLOCK_SPAN + number * PAGE_SIZE;
      pageBase[p] = keyBase + 1;
      let live = 0;
      for (let slot = 0; slot < PAGE_SIZE; slot++) {
        const entry = d[base + SLOTS + slot]!;
        if (entry === 0) continue;
        live++;
        const b = entry - 1;
        check(b < n && pool.contentKey[b] === keyBase + slot, `index has ${keyBase + slot} → ${b}`);
        check(pool.keyPage[b] === p, `block ${b}'s page is ${pool.keyPage[b]}, not ${p}`);
      }
      check(
        live > 0 && d[base + LIVE] === live,
        `page ${p} counts ${d[base + LIVE]}, holds ${live}`,
      );
      entries += live;
    }
  }
  for (let f = pool.pageFree - 1; f >= 0; f = d[f * PAGE_STRIDE + NEXT]! - 1) {
    check(f < pool.pagesUsed && pageBase[f] === 0, `free page ${f} is in use or listed twice`);
    pageBase[f] = -1;
    for (let i = 0; i < PAGE_STRIDE; i++) {
      if (i !== NEXT) check(d[f * PAGE_STRIDE + i] === 0, `free page ${f} is not clear`);
    }
  }
  for (let p = 0; p < pool.pagesUsed; p++) check(pageBase[p] !== 0, `page ${p} is lost`);
  for (let i = pool.pagesUsed * PAGE_STRIDE; i < d.length; i++) {
    check(d[i] === 0, 'index has data past its used pages');
  }
  const hint = pool.hintPage;
  if (hint !== -1) {
    check(hint >= 0 && hint < pool.pagesUsed, `hint page ${hint}`);
    check(pageBase[hint] === pool.hintBase + 1, `hint base ${pool.hintBase} is not page ${hint}'s`);
  } else {
    check(pool.hintBase === -1, `hint base ${pool.hintBase} without a page`);
  }
  return entries;
}
