import { describe, expect, it } from 'vitest';
import type { Patch, TunableParams } from '../../engine/api.ts';
import { simMs } from '../../engine/time.ts';
import { fixtureSimConfig } from '../../fixtures/scenarios.ts';
import type { DrawerParam } from '../../scenarios/schema.ts';
import {
  changesHold,
  decimalsOf,
  forkLabel,
  formatClock,
  formatDurationMs,
  formatParamValue,
  paramsAt,
  presetLabel,
  sameParams,
} from './params.ts';

const base = fixtureSimConfig(2).tunable;
const t = (h: number, m = 0) => simMs(1, h, m);
const set = (atMs: number, changes: Partial<TunableParams>): Patch => ({
  kind: 'set',
  atMs,
  changes,
});

describe('paramsAt', () => {
  it('returns the base values when no patch is in effect', () => {
    expect(paramsAt(base, [], t(10))).toBe(base);
    expect(paramsAt(base, [set(t(11), { loadMultiplier: 2 })], t(10))).toBe(base);
  });

  it('applies set patches dated at or before the time, in time order', () => {
    const patches = [
      set(t(12), { loadMultiplier: 1.5 }),
      set(t(10), { loadMultiplier: 1.2, routingPolicy: 'sessionAffinity' }),
    ];
    expect(paramsAt(base, patches, t(10))).toMatchObject({
      loadMultiplier: 1.2,
      routingPolicy: 'sessionAffinity',
    });
    expect(paramsAt(base, patches, t(12))).toMatchObject({
      loadMultiplier: 1.5,
      routingPolicy: 'sessionAffinity',
    });
  });

  it('lets a later patch win a tie at the same time', () => {
    const patches = [set(t(10), { loadMultiplier: 1.2 }), set(t(10), { loadMultiplier: 0.8 })];
    expect(paramsAt(base, patches, t(10)).loadMultiplier).toBe(0.8);
  });

  it('carries lasting changes into later days and ignores events', () => {
    const patches: Patch[] = [
      set(simMs(0, 16), { admissionLimitPerReplica: 8 }),
      { kind: 'event', atMs: simMs(0, 16), event: { type: 'crash', replica: 0 } },
    ];
    const params = paramsAt(base, patches, simMs(3, 9));
    expect(params.admissionLimitPerReplica).toBe(8);
    expect(sameParams(params, { ...base, admissionLimitPerReplica: 8 })).toBe(true);
  });

  it('keeps null values and skips undefined ones', () => {
    const patches = [set(t(9), { timeoutToFirstTokenMs: null, maxRetries: undefined })];
    const params = paramsAt(base, patches, t(10));
    expect(params.timeoutToFirstTokenMs).toBeNull();
    expect(params.maxRetries).toBe(base.maxRetries);
  });
});

describe('sameParams and changesHold', () => {
  it('compares every value', () => {
    expect(sameParams(base, { ...base })).toBe(true);
    expect(sameParams(base, { ...base, loadMultiplier: 1.1 })).toBe(false);
  });

  it('tells whether a named fix is in effect', () => {
    const fix = { routingPolicy: 'sessionAffinity' as const, admissionLimitPerReplica: 8 };
    expect(changesHold(base, fix)).toBe(false);
    expect(changesHold({ ...base, ...fix }, fix)).toBe(true);
  });
});

describe('formatting', () => {
  const load: DrawerParam = {
    param: 'loadMultiplier',
    label: 'Load',
    control: { kind: 'range', min: 0.5, max: 2, step: 0.1, unit: '×' },
  };
  const routing: DrawerParam = {
    param: 'routingPolicy',
    label: 'Routing policy',
    control: {
      kind: 'select',
      options: [
        { value: 'roundRobin', label: 'Round-robin' },
        { value: 'sessionAffinity', label: 'Session affinity' },
      ],
    },
  };
  const admission: DrawerParam = {
    param: 'admissionLimitPerReplica',
    label: 'Admission control',
    control: { kind: 'toggle', off: null, on: 8 },
  };
  const timeout: DrawerParam = {
    param: 'timeoutToFirstTokenMs',
    label: 'Client timeout',
    control: { kind: 'range', min: 10_000, max: 120_000, step: 5_000, unit: 'ms' },
  };

  it('writes readable fork labels for each control kind', () => {
    expect(forkLabel(load, 1.1)).toBe('Load: 1.1×');
    expect(forkLabel(routing, 'sessionAffinity')).toBe('Routing policy: Session affinity');
    expect(forkLabel(admission, 8)).toBe('Admission control: On');
    expect(forkLabel(admission, null)).toBe('Admission control: Off');
    expect(forkLabel(timeout, 45_000)).toBe('Client timeout: 45 s');
    expect(forkLabel(timeout, null)).toBe('Client timeout: None');
  });

  it('falls back to the raw value for a select value that is not an option', () => {
    expect(formatParamValue('weighted', routing.control)).toBe('weighted');
  });

  it('derives decimals from the step', () => {
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(1000)).toBe(0);
  });

  it('formats durations in plain units', () => {
    expect(formatDurationMs(500)).toBe('500 ms');
    expect(formatDurationMs(1_500)).toBe('1.5 s');
    expect(formatDurationMs(90_000)).toBe('90 s');
    expect(formatDurationMs(150_000)).toBe('2.5 min');
    expect(formatDurationMs(2 * 3_600_000)).toBe('2 h');
  });

  it('names presets with their replica count', () => {
    expect(presetLabel({ name: '1 GPU', replicas: 1, basis: 'measured' })).toBe('1 GPU');
    expect(presetLabel({ name: 'Server B', replicas: 8, basis: 'extrapolated' })).toBe(
      'Server B · 8 replicas',
    );
  });

  it('shows the playhead as day and time', () => {
    expect(formatClock(simMs(2, 10, 28, 5))).toBe('Wed 10:28:05');
    expect(formatClock(simMs(4, 16, 59, 59) + 999)).toBe('Fri 16:59:59');
    expect(formatClock(0)).toBe('Mon 00:00:00');
  });
});
