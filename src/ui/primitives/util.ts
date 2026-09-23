/** Joins class names, skipping falsy values. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Tabbable descendants of `root`, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[hidden]') && el.tabIndex >= 0,
  );
}

/** Moves the index by `delta` with wraparound, skipping indices where `skip` is true. */
export function step(from: number, delta: 1 | -1, count: number, skip: (i: number) => boolean) {
  for (let n = 1; n <= count; n++) {
    const i = (((from + delta * n) % count) + count) % count;
    if (!skip(i)) return i;
  }
  return from;
}

/** The first and last indices where `skip` is false, or -1 when there are none. */
export function ends(count: number, skip: (i: number) => boolean): [number, number] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < count; i++) {
    if (skip(i)) continue;
    if (first < 0) first = i;
    last = i;
  }
  return [first, last];
}
