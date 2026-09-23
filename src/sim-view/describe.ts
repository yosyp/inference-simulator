// The canvas's text alternative (05 §10): a short summary of the scene for screen readers, e.g.
// "8 replicas; replica 3 down; highest KV 94% on replica 5; 212 running, 38 waiting". The live
// status line (U6) is the aria-live region; this is read on demand.

import { REPLICA_STATE } from '../engine/results.ts';
import type { SceneState } from '../playback/types.ts';
import { replicaStyleKey, replicaStyles } from '../ui/theme/encodings.ts';
import { formatCount, formatPercent, trackedOutcome } from './format.ts';
import { previousTurn } from './tracked.ts';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeScene(scene: SceneState): string {
  const n = scene.replicas.length;
  const parts: string[] = [plural(n, 'replica', 'replicas')];
  if (scene.mode === 'highSide') {
    parts.push('high side: no live telemetry');
    return parts.join('; ');
  }

  let running = 0;
  let waiting = 0;
  let maxKv = -1;
  let maxKvReplica = -1;
  for (const r of scene.replicas) {
    const key = replicaStyleKey(r.state);
    if (key !== 'ready') {
      const style = replicaStyles[key];
      const progress =
        r.phaseProgress !== null && key !== 'down' && key !== 'crashed'
          ? ` ${formatPercent(r.phaseProgress)}`
          : '';
      parts.push(`replica ${r.replica + 1} ${style.label.toLowerCase()}${progress}`);
    }
    if (r.state !== REPLICA_STATE.ready) continue;
    if (Number.isFinite(r.running)) running += r.running;
    if (Number.isFinite(r.waiting)) waiting += r.waiting;
    if (Number.isFinite(r.kvUsedFrac) && r.kvUsedFrac > maxKv) {
      maxKv = r.kvUsedFrac;
      maxKvReplica = r.replica;
    }
  }
  if (maxKvReplica >= 0) {
    parts.push(
      n === 1
        ? `KV ${formatPercent(maxKv)}`
        : `highest KV ${formatPercent(maxKv)} on replica ${maxKvReplica + 1}`,
    );
  }
  parts.push(`${formatCount(running)} running, ${formatCount(waiting)} waiting`);
  if (scene.detail === 'aggregate') parts.push('showing flow, not individual requests');

  const t = scene.tracked;
  if (t) {
    const i = t.requests.length - 1;
    const cur = t.requests[i];
    if (!cur) {
      parts.push(`tracking analyst ${t.analyst}, no turns yet`);
    } else {
      const where = cur.replica === null ? 'at the router' : `on replica ${cur.replica + 1}`;
      const prev = previousTurn(t.requests, i);
      const moved =
        cur.moved && prev && prev.replica !== null && prev.replica !== cur.replica
          ? `, moved from replica ${prev.replica + 1}`
          : cur.moved
            ? ', moved'
            : '';
      const outcome = trackedOutcome(cur);
      const lost = cur.state === 'rejected' || cur.state === 'timedOut' || cur.state === 'failed';
      const ttft =
        cur.ttftMs !== null && !lost
          ? `TTFT ${outcome}`
          : lost
            ? outcome
            : `${outcome}, no first token yet`;
      parts.push(`tracking analyst ${t.analyst}: turn ${cur.turn} ${where}, ${ttft}${moved}`);
    }
  }
  return parts.join('; ');
}
