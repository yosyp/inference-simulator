// The parameters drawer (05 §4), generated from the scenario's descriptors. Every committed
// change forks the run at the playhead with a lasting 'set' patch. Selects and toggles commit on
// change; range sliders commit on release (pointer up, key up, or blur), not on every step.

import { useEffect, useId, useRef, useState } from 'react';
import type { TunableParams } from '../../engine/api.ts';
import type { DrawerParam } from '../../scenarios/schema.ts';
import { Drawer } from '../primitives/Drawer.tsx';
import { cx } from '../primitives/util.ts';
import {
  controlOf,
  forkLabel,
  formatParamValue,
  formatRangeValue,
  type ParamValue,
  type RangeControl,
  type SelectControl,
  type ToggleControl,
} from './params.ts';

export interface ParametersDrawerProps {
  id: string;
  open: boolean;
  onClose: () => void;
  params: readonly DrawerParam[];
  /** Values in effect at the playhead (useParamsInEffect). */
  values: TunableParams;
  /** Called once per committed change with a readable fork label. */
  onChange: (changes: Partial<TunableParams>, label: string) => void;
}

export function ParametersDrawer({
  id,
  open,
  onClose,
  params,
  values,
  onChange,
}: ParametersDrawerProps) {
  return (
    <Drawer id={id} open={open} onClose={onClose} title="Parameters">
      <p className="text-xs text-ink-subtle">
        Each change forks the run at the playhead. Values show what is in effect there.
      </p>
      {params.length === 0 ? (
        <p className="text-sm text-ink-muted">This tab has no adjustable parameters.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-3 pb-1">
          {params.map((p) => (
            <ParamField
              key={p.param}
              param={p}
              value={values[p.param]}
              onCommit={(v) => onChange({ [p.param]: v }, forkLabel(p, v))}
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}

interface FieldProps<C> {
  param: DrawerParam;
  control: C;
  value: ParamValue;
  onCommit: (value: ParamValue) => void;
  labelId: string;
  inputId: string;
  helpId: string | undefined;
}

function ParamField({
  param,
  value,
  onCommit,
}: {
  param: DrawerParam;
  value: ParamValue;
  onCommit: (value: ParamValue) => void;
}) {
  const base = useId();
  const ids = {
    labelId: `${base}-label`,
    inputId: `${base}-input`,
    helpId: param.help ? `${base}-help` : undefined,
  };
  const control = controlOf(param);
  const common = { param, value, onCommit, ...ids };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-param={param.param}>
      {control.kind === 'select' && <SelectField control={control} {...common} />}
      {control.kind === 'range' && <RangeField control={control} {...common} />}
      {control.kind === 'toggle' && <ToggleField control={control} {...common} />}
      {param.help && (
        <p id={ids.helpId} className="text-2xs text-ink-subtle">
          {param.help}
        </p>
      )}
    </div>
  );
}

const labelClass = 'text-xs font-medium text-ink';
const valueClass = 'text-xs text-ink-muted tabular-nums';

function SelectField({
  param,
  control,
  value,
  onCommit,
  labelId,
  inputId,
  helpId,
}: FieldProps<SelectControl>) {
  const index = control.options.findIndex((o) => Object.is(o.value, value));
  return (
    <>
      <label id={labelId} htmlFor={inputId} className={labelClass}>
        {param.label}
      </label>
      <select
        id={inputId}
        aria-describedby={helpId}
        value={index}
        onChange={(e) => {
          const next = control.options[Number(e.target.value)];
          if (next && !Object.is(next.value, value)) onCommit(next.value);
        }}
        className="h-7 rounded border border-border-strong bg-surface px-1.5 text-sm text-ink"
      >
        {index < 0 && (
          <option value={-1} disabled>
            {formatParamValue(value, control)}
          </option>
        )}
        {control.options.map((o, i) => (
          <option key={i} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
}

function RangeField({
  param,
  control,
  value,
  onCommit,
  labelId,
  inputId,
  helpId,
}: FieldProps<RangeControl>) {
  const committed = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const [draft, setDraft] = useState<number | null>(null);
  // Mirrors draft for event handlers, which may run before a re-render.
  const draftRef = useRef<number | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const shown = draft ?? committed;

  const commit = () => {
    const v = draftRef.current;
    if (v === null) return;
    draftRef.current = null;
    setDraft(null);
    if (!Object.is(v, committed)) onCommit(v);
  };

  const stopListening = () => {
    if (releaseRef.current) window.removeEventListener('pointerup', releaseRef.current);
    releaseRef.current = null;
  };
  useEffect(() => stopListening, []);

  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <label id={labelId} htmlFor={inputId} className={labelClass}>
          {param.label}
        </label>
        <output htmlFor={inputId} className={valueClass}>
          {formatRangeValue(shown, control)}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        aria-describedby={helpId}
        aria-valuetext={formatRangeValue(shown, control)}
        min={control.min}
        max={control.max}
        step={control.step}
        value={shown ?? control.min}
        onChange={(e) => {
          const v = Number(e.target.value);
          draftRef.current = v;
          setDraft(v);
        }}
        onPointerDown={() => {
          // Catch a release outside the slider too.
          stopListening();
          const release = () => {
            stopListening();
            commit();
          };
          releaseRef.current = release;
          window.addEventListener('pointerup', release);
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="h-5 w-full accent-ink"
      />
    </>
  );
}

function ToggleField({
  param,
  control,
  value,
  onCommit,
  labelId,
  inputId,
  helpId,
}: FieldProps<ToggleControl>) {
  const on = Object.is(value, control.on);
  return (
    <div className="flex items-center justify-between gap-2">
      <span id={labelId} className={labelClass}>
        {param.label}
      </span>
      <button
        id={inputId}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        onClick={() => onCommit(on ? control.off : control.on)}
        className="inline-flex h-6 items-center gap-1.5 rounded border border-border-strong bg-surface px-1.5 text-xs"
      >
        <span
          aria-hidden
          className={cx(
            'relative h-3 w-5 rounded-full border border-ink transition-colors',
            on ? 'bg-ink' : 'bg-surface',
          )}
        >
          <span
            className={cx(
              'absolute top-px size-2 rounded-full transition-[left]',
              on ? 'left-2.5 bg-surface' : 'left-px bg-ink',
            )}
          />
        </span>
        <span className={valueClass}>{on ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}
