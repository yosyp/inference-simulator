// Scenario-level helpers: the "all tabs" timing assertion (§7.3), and parsing pnpm sim's
// --patch and --until arguments.

import type { HashScheme, RetryPolicy, RoutingPolicy, TunableParams } from '../../engine/api.ts';
import { DAY_MS, DAY_NAMES, HOUR_MS, MINUTE_MS, type SimMs } from '../../engine/time.ts';
import type { Scenario } from '../schema.ts';

/**
 * Wall seconds from the entry point to the lesson moment at the entry speed (sim s per wall s):
 * (lesson moment − entry) ÷ speed. §7.3 "All": ≤ 45 s. Assumes both lie in one shift; playback
 * skips off-shift time, which this doesn't subtract.
 */
export function entryToMomentWallS(scenario: Scenario): number {
  return (scenario.lessonMoment.atMs - scenario.entry.atMs) / scenario.entry.speed / 1000;
}

/** "HH:MM" or "H:MM" → ms after midnight. */
export function parseTimeOfDay(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`Expected a time of day as HH:MM, got "${text}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`No such time of day: ${text}`);
  return h * HOUR_MS + min * MINUTE_MS;
}

/** ms after midnight → "HH:MM" (seconds are shown when present). */
export function formatTimeOfDay(ms: number): string {
  const t = Math.round(ms / 1000);
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = t % 60;
  return ss === 0 ? `${hh}:${mm}` : `${hh}:${mm}:${String(ss).padStart(2, '0')}`;
}

/** Simulated time → "Wed 10:30". */
export function formatSimMs(ms: SimMs): string {
  const d = Math.floor(ms / DAY_MS);
  const name = DAY_NAMES[d]?.slice(0, 3) ?? `day ${d}`;
  return `${name} ${formatTimeOfDay(ms - d * DAY_MS)}`;
}

const ENUMS: Partial<Record<keyof TunableParams, readonly string[]>> = {
  routingPolicy: [
    'roundRobin',
    'leastOutstanding',
    'sessionAffinity',
    'kvUtilization',
    'weighted',
  ] satisfies RoutingPolicy[],
  hashScheme: ['modN', 'consistent'] satisfies HashScheme[],
  retryPolicy: ['none', 'immediate', 'fixed', 'exponential', 'fullJitter'] satisfies RetryPolicy[],
};

const NULLABLE: readonly (keyof TunableParams)[] = [
  'timeoutToFirstTokenMs',
  'admissionLimitPerReplica',
];

/**
 * Parses "key=value" into a TunableParams change, typed by the parameter: numbers, "null" for
 * timeoutToFirstTokenMs and admissionLimitPerReplica, and the policy names for the enums.
 */
export function parsePatchArg(arg: string, base: TunableParams): Partial<TunableParams> {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new Error(`Expected --patch key=value, got "${arg}"`);
  const key = arg.slice(0, eq).trim() as keyof TunableParams;
  const raw = arg.slice(eq + 1).trim();
  if (!(key in base)) {
    throw new Error(`Unknown parameter "${key}". Tunable: ${Object.keys(base).join(', ')}`);
  }
  const allowed = ENUMS[key];
  if (allowed) {
    if (!allowed.includes(raw)) throw new Error(`${key} must be one of ${allowed.join(', ')}`);
    return { [key]: raw };
  }
  if (raw === 'null' && NULLABLE.includes(key)) return { [key]: null };
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) throw new Error(`${key} needs a number, got "${raw}"`);
  return { [key]: n };
}

/** Parses several "key=value" args into one change set (later keys win). */
export function parsePatchArgs(
  args: readonly string[],
  base: TunableParams,
): Partial<TunableParams> {
  return Object.assign({}, ...args.map((a) => parsePatchArg(a, base))) as Partial<TunableParams>;
}
