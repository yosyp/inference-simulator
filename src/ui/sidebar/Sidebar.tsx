// The sidebar (05 §8, K17): the tab's static text carries the lesson for a self-serve visitor
// (a boxed summary and takeaway under the title, then what to watch and what to try),
// with the live status line (Live) or the rollup table (High side, 05 §9), and the calibration
// footnote.

import { useId, type ReactNode } from 'react';
import type { Calibration } from '../../engine/calibration.ts';
import type { Mode, PlaybackStore } from '../../playback/types.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import { presetLabel } from '../chrome/params.ts';
import { Button } from '../primitives/Button.tsx';
import { Footnote } from './Footnote.tsx';
import { RollupSection } from './RollupSection.tsx';
import { StatusLine } from './StatusLine.tsx';

export interface SidebarProps {
  store: PlaybackStore;
  scenario: Scenario;
  mode: Mode;
  calibration: Calibration;
  /** The High-side rollup table (U7). Shown only on the High side. */
  rollup?: ReactNode;
  /** Reopens the intro. */
  onShowIntro?: () => void;
}

export function Sidebar({ store, scenario, mode, calibration, rollup, onShowIntro }: SidebarProps) {
  const { copy, lesson } = scenario;
  const id = useId();
  return (
    <div className="flex min-h-full flex-col gap-4 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
          Inference Simulator
        </h1>
        {onShowIntro && (
          <Button variant="ghost" size="sm" onClick={onShowIntro}>
            About
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold">
          <span className="tabular-nums">{scenario.tab}</span> · {scenario.title}
        </h2>
        <p className="text-xs text-ink-subtle">
          {presetLabel(scenario.preset)} ·{' '}
          {scenario.preset.basis === 'extrapolated' ? 'Extrapolated' : 'Measured hardware'}
        </p>
      </div>

      {lesson && (
        <section
          aria-labelledby={`${id}-lesson`}
          className="flex flex-col gap-1 rounded border border-l-4 border-border-strong border-l-focus bg-surface-muted px-3 py-2.5"
        >
          <h3
            id={`${id}-lesson`}
            className="text-xs font-semibold tracking-wide text-ink-subtle uppercase"
          >
            The lesson
          </h3>
          <p className="text-sm text-ink">{lesson.summary}</p>
          <p className="text-sm font-medium text-ink">{lesson.takeaway}</p>
        </section>
      )}

      <section aria-labelledby={`${id}-watch`} className="flex flex-col gap-1.5">
        <h3 id={`${id}-watch`} className="text-sm font-semibold">
          What to watch
        </h3>
        {copy.whatToWatch.map((p, i) => (
          <p key={i} className="text-sm text-ink-muted">
            {p}
          </p>
        ))}
      </section>

      <section aria-labelledby={`${id}-try`} className="flex flex-col gap-1.5">
        <h3 id={`${id}-try`} className="text-sm font-semibold">
          Try this
        </h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-muted">
          {copy.tryThis.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </section>

      {mode === 'live' ? (
        <section aria-labelledby={`${id}-status`} className="flex flex-col gap-1">
          <h3 id={`${id}-status`} className="text-sm font-semibold">
            Live status
          </h3>
          <div className="rounded border border-border bg-bg px-2.5 py-2">
            <StatusLine store={store} templates={scenario.statusTemplates} />
          </div>
        </section>
      ) : (
        <RollupSection key={scenario.id}>{rollup}</RollupSection>
      )}

      <Footnote calibration={calibration} preset={scenario.preset} className="mt-auto" />
    </div>
  );
}
