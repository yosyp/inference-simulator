// Detail windows (protocol.ts 'requestDetail'; 02 §11, K7). A detail chunk must place every request
// already in flight at the window's start. After replaying to fromMs, E11 calls inFlightTransitions
// and puts its rows in front of the window's transitions: one synthetic row per live request, at
// nowMs, with its current state and replica.

import type { DayRunInput } from '../api.ts';
import type { DayState } from '../core/types.ts';
import { allocTransitionBlock, type TransitionBlock } from '../results.ts';

export function inFlightTransitions(
  state: DayState,
  input: Pick<DayRunInput, 'detail' | 'trackedAnalyst'>,
): TransitionBlock {
  const t = state.shared.requests;
  const nowMs = state.core.nowMs;
  const slots: number[] = [];
  for (let s = 0; s < t.capacity; s++) {
    if (t.live[s] !== 1) continue;
    if (input.detail === 'all' || t.analyst[s] === input.trackedAnalyst) slots.push(s);
  }
  slots.sort((a, b) => t.id[a]! - t.id[b]!);
  const out = allocTransitionBlock(input.detail, slots.length);
  slots.forEach((s, k) => {
    out.atMs[k] = nowMs;
    out.request[k] = t.id[s]!;
    out.analyst[k] = t.analyst[s]!;
    out.replica[k] = t.replica[s]!;
    out.state[k] = t.state[s]!;
  });
  return out;
}
