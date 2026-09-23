// Parameters in effect at the playhead, and how drawer values and fork labels read (05 §4).
// The drawer tracks lasting changes locally: the scenario's starting values, its baseline 'set'
// patches, and the 'set' forks this run applied. The store keeps only fork labels.

import type { Patch, TunableParams } from '../../engine/api.ts';
import { DAY_NAMES, DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, type SimMs } from '../../engine/time.ts';
import type { DrawerParam, Preset } from '../../scenarios/schema.ts';

export type ParamKey = keyof TunableParams;
export type ParamValue = TunableParams[ParamKey];

export interface SelectControl {
  kind: 'select';
  options: readonly { value: ParamValue; label: string }[];
}
export interface RangeControl {
  kind: 'range';
  min: number;
  max: number;
  step: number;
  unit?: string;
}
export interface ToggleControl {
  kind: 'toggle';
  off: ParamValue;
  on: ParamValue;
}
/** Any drawer control, with its value type widened to ParamValue. */
export type AnyControl = SelectControl | RangeControl | ToggleControl;

export function controlOf(param: DrawerParam): AnyControl {
  return param.control;
}

type SetPatch = Extract<Patch, { kind: 'set' }>;

/**
 * The tunable parameters in effect at atMs: `base`, then every 'set' patch dated at or before
 * atMs, in time order. Patches at the same time apply in the order given, so list baseline
 * patches first and forks in the order they were made (a later fork wins a tie).
 */
export function paramsAt(
  base: TunableParams,
  patches: readonly Patch[],
  atMs: SimMs,
): TunableParams {
  const sets = patches
    .filter((p): p is SetPatch => p.kind === 'set' && p.atMs <= atMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (sets.length === 0) return base;
  const out: Record<string, unknown> = { ...base };
  for (const p of sets) {
    for (const [key, value] of Object.entries(p.changes)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out as unknown as TunableParams;
}

export function sameParams(a: TunableParams, b: TunableParams): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as ParamKey[]) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

/** True when every change already holds in `params` (e.g. a named fix that is in effect). */
export function changesHold(params: TunableParams, changes: Partial<TunableParams>): boolean {
  return (Object.keys(changes) as ParamKey[]).every(
    (key) => changes[key] === undefined || Object.is(params[key], changes[key]),
  );
}

/** Decimal places a range step implies: 0.1 gives 1, 0.25 gives 2, 1000 gives 0. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || Number.isInteger(step)) return 0;
  const text = String(step);
  const exp = /e-(\d+)$/.exec(text);
  if (exp) return Number(exp[1]);
  return text.split('.')[1]?.length ?? 0;
}

/** Units written without a space: 1.5×, 80%. */
const TIGHT_UNITS = new Set(['×', 'x', '%']);

/** A duration in plain units: 500 ms, 1.5 s, 65 s, 2.5 min. Seconds up to two minutes. */
export function formatDurationMs(ms: number): string {
  if (Math.abs(ms) < SECOND_MS) return `${trim(ms, 0)} ms`;
  if (Math.abs(ms) < 2 * MINUTE_MS) return `${trim(ms / SECOND_MS, 1)} s`;
  if (Math.abs(ms) < HOUR_MS) return `${trim(ms / MINUTE_MS, 1)} min`;
  return `${trim(ms / HOUR_MS, 1)} h`;
}

function trim(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

export function formatRangeValue(value: ParamValue, control: RangeControl): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'None';
  const { unit } = control;
  if (unit === 'ms') return formatDurationMs(value);
  const text = value.toFixed(decimalsOf(control.step));
  if (!unit) return text;
  return TIGHT_UNITS.has(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/** How a drawer value reads on screen and in fork labels. */
export function formatParamValue(value: ParamValue, control: AnyControl): string {
  switch (control.kind) {
    case 'select':
      return control.options.find((o) => Object.is(o.value, value))?.label ?? fallback(value);
    case 'toggle':
      if (Object.is(value, control.on)) return 'On';
      if (Object.is(value, control.off)) return 'Off';
      return fallback(value);
    case 'range':
      return formatRangeValue(value, control);
  }
}

function fallback(value: ParamValue): string {
  return value === null ? 'None' : String(value);
}

/** The fork label for a drawer change, e.g. "Routing policy: Session affinity". */
export function forkLabel(param: DrawerParam, value: ParamValue): string {
  return `${param.label}: ${formatParamValue(value, controlOf(param))}`;
}

/** "1 GPU", "2 replicas", "Server B · 8 replicas". */
export function presetLabel(preset: Preset): string {
  return /\d/.test(preset.name) ? preset.name : `${preset.name} · ${preset.replicas} replicas`;
}

const SHORT_DAYS = DAY_NAMES.map((d) => d.slice(0, 3));

/** The playhead as "Wed 10:28:05". */
export function formatClock(atMs: SimMs): string {
  const t = Math.max(0, atMs);
  const day = Math.min(SHORT_DAYS.length - 1, Math.floor(t / DAY_MS));
  let rest = Math.floor((t - day * DAY_MS) / SECOND_MS);
  const s = rest % 60;
  rest = (rest - s) / 60;
  const m = rest % 60;
  const h = (rest - m) / 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${SHORT_DAYS[day]} ${pad(h)}:${pad(m)}:${pad(s)}`;
}
