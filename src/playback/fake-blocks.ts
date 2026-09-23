// Columnar block helpers and synthetic rollup rows for the fake engine (fake-transport.ts).

import type { AnalystId } from '../engine/api.ts';
import {
  allocRequestBlock,
  allocTransitionBlock,
  type RequestBlock,
  type RollupRow,
  type TransitionBlock,
} from '../engine/results.ts';
import { DAY_MS, rollupDeliveryMs, type DayIndex } from '../engine/time.ts';
import { signals, type FixtureOptions } from '../fixtures/synthetic.ts';

type Block = RequestBlock | TransitionBlock;
type Column = { length: number; [i: number]: number };

function columns(block: Block): [string, Column][] {
  return Object.entries(block).filter(([, v]) => ArrayBuffer.isView(v)) as [string, Column][];
}

function alloc<T extends Block>(like: T, scope: Block['scope'], count: number): T {
  return (
    'arriveMs' in like ? allocRequestBlock(scope, count) : allocTransitionBlock(scope, count)
  ) as T;
}

/** Concatenates blocks of one kind, keeping the rows where keep(block, row) holds. */
export function concatBlocks<T extends Block>(
  empty: T,
  blocks: readonly T[],
  scope: Block['scope'],
  keep: (block: T, row: number) => boolean = () => true,
): T {
  const picks: [T, number][] = [];
  for (const b of blocks) for (let i = 0; i < b.count; i++) if (keep(b, i)) picks.push([b, i]);
  const out = alloc(empty, scope, picks.length);
  const outCols = new Map(columns(out));
  picks.forEach(([b, row], i) => {
    for (const [key, col] of columns(b)) outCols.get(key)![i] = col[row]!;
  });
  return out;
}

export function setAnalyst(block: Block, analyst: AnalystId): void {
  block.analyst.fill(analyst);
}

/** Per-replica daily rollup (01 §8), sampled from the synthetic signals. */
export function fakeRollup(opts: FixtureOptions, day: DayIndex): RollupRow[] {
  const samples = 96;
  const rows: RollupRow[] = [];
  for (let r = 0; r < opts.replicas; r++) {
    let served = 0;
    let e2e = 0;
    let util = 0;
    for (let k = 0; k < samples; k++) {
      const s = signals(opts, r, day * DAY_MS + (k + 0.5) * (DAY_MS / samples));
      const n = (s.requestsPerMin * (DAY_MS / samples)) / 60_000;
      served += n;
      e2e += n * (s.ttftMedianMs * 1.3 + 300 * s.tpotMedianMs);
      util += s.nvidiaSmiUtil / samples;
    }
    rows.push({
      day,
      replica: r,
      requestsServed: Math.round(served),
      meanE2eMs: served > 0 ? e2e / served : NaN,
      meanNvidiaSmiUtil: util,
      deliveredAtMs: rollupDeliveryMs(day),
    });
  }
  return rows;
}
