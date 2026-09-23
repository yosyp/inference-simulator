import { describe, expect, it } from 'vitest';
import { REPLICA_STATE } from '../engine/results.ts';
import { describeScene } from './describe.ts';
import { replica, scene, turn } from './test-support.ts';

describe('describeScene', () => {
  it('names replica states, the fullest KV, and the load', () => {
    const s = scene({
      replicas: [0, 1, 2, 3, 4, 5, 6, 7].map((r) =>
        replica(r, {
          kvUsedFrac: r === 4 ? 0.94 : 0.5,
          running: 10,
          waiting: 1,
          ...(r === 2 ? { state: REPLICA_STATE.down } : {}),
          ...(r === 6 ? { state: REPLICA_STATE.loadingWeights, phaseProgress: 0.4 } : {}),
        }),
      ),
    });
    expect(describeScene(s)).toBe(
      '8 replicas; replica 3 down; replica 7 loading weights 40%; highest KV 94% on replica 5; 60 running, 6 waiting',
    );
  });

  it('keeps one replica short', () => {
    expect(describeScene(scene())).toBe('1 replica; KV 50%; 10 running, 2 waiting');
  });

  it('says when it shows flow rather than requests', () => {
    expect(describeScene(scene({ detail: 'aggregate' }))).toContain(
      'showing flow, not individual requests',
    );
  });

  it('describes the tracked analyst’s latest turn and whether it moved', () => {
    const s = scene({
      replicas: [replica(0), replica(1)],
      tracked: {
        analyst: 12,
        requests: [
          turn({ turn: 1, replica: 0 }),
          turn({ turn: 2, replica: 1, ttftMs: 2400, moved: true }),
        ],
      },
    });
    expect(describeScene(s)).toContain(
      'tracking analyst 12: turn 2 on replica 2, TTFT 2.4 s, moved from replica 1',
    );
    const waiting = {
      ...s,
      tracked: {
        analyst: 12,
        requests: [turn({ turn: 1, replica: null, ttftMs: null, state: 'queued' })],
      },
    };
    expect(describeScene(waiting)).toContain('turn 1 at the router, queued, no first token yet');
    const lost = {
      ...s,
      tracked: { analyst: 12, requests: [turn({ turn: 1, ttftMs: null, state: 'timedOut' })] },
    };
    expect(describeScene(lost)).toContain('turn 1 on replica 1, timed out');
    expect(describeScene({ ...s, tracked: { analyst: 12, requests: [] } })).toContain(
      'tracking analyst 12, no turns yet',
    );
  });

  it('goes quiet on the high side', () => {
    const s = scene({
      mode: 'highSide',
      replicas: [replica(0, { state: REPLICA_STATE.down }), replica(1)],
    });
    expect(describeScene(s)).toBe('2 replicas; high side: no live telemetry');
  });
});
