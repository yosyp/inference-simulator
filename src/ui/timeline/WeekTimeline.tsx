// The week timeline (00-build U5; 05 §5, §10; K16, K18, K21, K26). A scrubbable bar from Monday
// 00:00 to Friday 24:00 with off-shift hours shaded, the engine's computed ranges, the lesson moment
// and fork markers, and the playhead. The bar is a slider for keyboard users.
//
// Rendering: React draws the bar from throttled selectors (the structure at VIEW_HZ, the clock text
// at CLOCK_HZ, which changes once per simulated minute); the playhead moves every frame through a
// frame subscription (Playhead.tsx), so the bar does not re-render as it plays.

import type { ReactNode } from 'react';
import { memo, useCallback, useId } from 'react';
import {
  DAY_MS,
  DAY_NAMES,
  MINUTE_MS,
  WEEK_DAYS,
  WEEK_MS,
  type DayIndex,
} from '../../engine/time.ts';
import type { Shift } from '../../playback/shift.ts';
import type { EngineClientStore } from '../../playback/store.ts';
import type {
  ForkMarker,
  Mode,
  PlaybackState,
  PlaybackStore,
  ResultsIndex,
} from '../../playback/types.ts';
import { usePlaybackSelector } from '../../playback/use-playback-selector.ts';
import type { Scenario } from '../../scenarios/schema.ts';
import type { ComputedRange } from '../../worker/protocol.ts';
import { Tooltip } from '../primitives/Tooltip.tsx';
import { cx } from '../primitives/util.ts';
import { colors, withAlpha } from '../theme/colors.ts';
import { markerStyles } from '../theme/encodings.ts';
import { describeComputed, dayAt, formatDayTime, rollupTicks } from './format.ts';
import {
  ALL_DAY_SHIFT,
  leftPercent,
  offShiftSpans,
  visibleRanges,
  weekBounds,
  widthPercent,
} from './geometry.ts';
import { ForkGlyph, LessonGlyph } from './glyphs.tsx';
import { Playhead } from './Playhead.tsx';
import { useScrub } from './useScrub.ts';

/** Re-render rate for markers, computed ranges, and mode. */
export const TIMELINE_VIEW_HZ = 4;
/** Re-render rate for the clock readout and aria-valuetext (which change once per simulated minute). */
export const TIMELINE_CLOCK_HZ = 8;

export interface WeekTimelineProps {
  /** The playback store. Shift and lesson moment come from its loaded scenario (EngineClientStore). */
  store: PlaybackStore;
}

type Lesson = Scenario['lessonMoment'];

interface View {
  shift: Shift | null;
  lesson: Lesson | null;
  computed: readonly ComputedRange[];
  forks: readonly ForkMarker[];
  mode: Mode;
}

interface Clock {
  minute: number;
  buffering: boolean;
}

const sameView = (a: View, b: View) =>
  a.shift === b.shift &&
  a.lesson === b.lesson &&
  a.computed === b.computed &&
  a.forks === b.forks &&
  a.mode === b.mode;

const sameClock = (a: Clock, b: Clock) => a.minute === b.minute && a.buffering === b.buffering;

const selectClock = (s: PlaybackState): Clock => ({
  minute: Math.floor(s.playheadMs / MINUTE_MS),
  buffering: s.buffering,
});

/** The scenario the store has loaded, when the store can say (createPlaybackStore can). */
export function loadedScenario(store: PlaybackStore): Scenario | null {
  return (store as Partial<EngineClientStore>).scenario ?? null;
}

export function WeekTimeline({ store }: WeekTimelineProps) {
  const selectView = useCallback(
    (s: PlaybackState, _index: ResultsIndex): View => {
      const scenario = s.scenarioId === null ? null : loadedScenario(store);
      return {
        shift: scenario?.sim.shift ?? (s.scenarioId === null ? null : ALL_DAY_SHIFT),
        lesson: scenario?.lessonMoment ?? null,
        computed: s.computed,
        forks: s.forks,
        mode: s.mode,
      };
    },
    [store],
  );
  const view = usePlaybackSelector(store, selectView, {
    maxHz: TIMELINE_VIEW_HZ,
    equals: sameView,
  });
  const clock = usePlaybackSelector(store, selectClock, {
    maxHz: TIMELINE_CLOCK_HZ,
    equals: sameClock,
  });
  const handlers = useScrub(store, view.shift);
  const descId = useId();

  const loaded = view.shift !== null;
  const bounds = view.shift ? weekBounds(view.shift) : { startMs: 0, endMs: WEEK_MS };
  const shownMs = clock.minute * MINUTE_MS;
  const valueNow = Math.min(bounds.endMs, Math.max(bounds.startMs, shownMs));
  const buffering = loaded && clock.buffering;

  return (
    <div
      data-part="week-timeline"
      className="flex h-(--layout-timeline-h) items-stretch gap-3 px-3 select-none"
    >
      <div className="flex w-32 shrink-0 flex-col justify-center">
        <span aria-hidden data-part="readout" className="text-sm font-medium tabular-nums">
          {loaded ? formatDayTime(shownMs) : '—'}
        </span>
        <span role="status" className="h-4 text-2xs leading-4 text-ink-muted">
          {buffering ? 'Computing…' : ''}
        </span>
      </div>
      <div className="relative min-w-0 flex-1">
        <DayLabels currentDay={loaded ? dayAt(shownMs) : null} />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Simulated time"
          aria-valuemin={bounds.startMs}
          aria-valuemax={bounds.endMs}
          aria-valuenow={valueNow}
          aria-valuetext={loaded ? formatDayTime(shownMs) : 'No scenario loaded'}
          aria-disabled={loaded ? undefined : true}
          aria-describedby={descId}
          data-part="track"
          className={cx(
            'absolute inset-x-0 top-8 bottom-0 touch-none rounded-sm',
            loaded ? 'cursor-pointer' : 'cursor-default',
          )}
          {...handlers}
        >
          <Band
            shift={view.shift}
            computed={view.computed}
            lesson={view.lesson}
            forks={view.forks}
            highSide={view.mode === 'highSide'}
          />
          <Playhead store={store} buffering={buffering} hidden={!loaded} />
        </div>
        {loaded && <Markers store={store} lesson={view.lesson} forks={view.forks} />}
        <p id={descId} className="sr-only">
          {loaded ? describeComputed(view.computed) : ''}
        </p>
      </div>
    </div>
  );
}

const DayLabels = memo(function DayLabels({ currentDay }: { currentDay: DayIndex | null }) {
  return (
    <div aria-hidden className="absolute inset-x-0 top-0.5 flex h-4">
      {DAY_NAMES.map((name, d) => (
        <span
          key={name}
          data-part="day-label"
          data-current={d === currentDay || undefined}
          className={cx(
            'w-1/5 min-w-0 truncate px-1 text-center text-2xs leading-4',
            d === currentDay ? 'font-semibold text-ink' : 'text-ink-muted',
          )}
        >
          {name}
        </span>
      ))}
    </div>
  );
});

interface MarkersProps {
  store: PlaybackStore;
  lesson: Lesson | null;
  forks: readonly ForkMarker[];
}

/**
 * Marker buttons, each seeking to its time and labelled on hover or focus. They sit where the
 * playhead never covers them, since a tab opens paused just before its lesson moment and forks
 * start at the playhead: the lesson triangle above the bar, fork flags inside its top edge with
 * the pole on the fork's time, and the playhead's knob on the computed strip below.
 */
const Markers = memo(function Markers({ store, lesson, forks }: MarkersProps) {
  return (
    <>
      {lesson && (
        <MarkerButton
          kind="lesson"
          atMs={lesson.atMs}
          name={`Lesson moment, ${formatDayTime(lesson.atMs)}`}
          title="Lesson moment"
          label={lesson.label}
          onSeek={() => store.seek(lesson.atMs)}
          className="top-[18px] h-3.5 w-4 -translate-x-1/2 items-end justify-center"
        >
          <LessonGlyph />
        </MarkerButton>
      )}
      {forks.map((f) => (
        <MarkerButton
          key={f.revision}
          kind="fork"
          atMs={f.atMs}
          name={`${markerStyles.fork.label} at ${formatDayTime(f.atMs)}`}
          title={markerStyles.fork.label}
          label={f.label}
          onSeek={() => store.seek(f.atMs)}
          className="top-[34px] h-3 w-3 -translate-x-[2px] items-start justify-start"
        >
          <ForkGlyph />
        </MarkerButton>
      ))}
    </>
  );
});

interface MarkerButtonProps {
  kind: 'lesson' | 'fork';
  atMs: number;
  name: string;
  title: string;
  label: string;
  onSeek: () => void;
  /** Placement and glyph alignment. */
  className: string;
  children: ReactNode;
}

function MarkerButton(props: MarkerButtonProps) {
  const { kind, atMs, name, title, label, onSeek, className, children } = props;
  return (
    <Tooltip
      content={
        <>
          <span className="font-medium">{title}</span>
          <span className="text-surface/80"> · {formatDayTime(atMs)}</span>
          <br />
          {label}
        </>
      }
    >
      <button
        type="button"
        aria-label={name}
        data-part={`${kind}-marker`}
        className={cx('absolute flex cursor-pointer rounded-sm', className)}
        style={{ left: leftPercent(atMs) }}
        onClick={onSeek}
      >
        {children}
      </button>
    </Tooltip>
  );
}

interface BandProps {
  shift: Shift | null;
  computed: readonly ComputedRange[];
  lesson: Lesson | null;
  forks: readonly ForkMarker[];
  highSide: boolean;
}

const lessonBandColor = withAlpha(colors['series-incident'], markerStyles.incident.bandAlpha);
const forkDash = `repeating-linear-gradient(to bottom, ${markerStyles.fork.color} 0 3px, transparent 3px 6px)`;
const DIVIDERS = Array.from({ length: WEEK_DAYS - 1 }, (_, i) => (i + 1) * DAY_MS);

/** The bar itself: shifts and nights, day dividers, the computed strip, and marker lines. Decorative. */
const Band = memo(function Band({ shift, computed, lesson, forks, highSide }: BandProps) {
  return (
    <div aria-hidden className="absolute inset-0">
      <div
        data-part="band"
        className="absolute inset-x-0 top-0 h-6 overflow-hidden rounded-sm bg-surface ring-1 ring-border"
      >
        {shift &&
          offShiftSpans(shift).map((s) => (
            <div
              key={s.fromMs}
              data-part="off-shift"
              className="absolute inset-y-0 bg-surface-muted"
              style={{ left: leftPercent(s.fromMs), width: widthPercent(s.fromMs, s.toMs) }}
            />
          ))}
        {DIVIDERS.map((t) => (
          <div
            key={t}
            data-part="day-divider"
            className="absolute inset-y-0 w-px bg-border"
            style={{ left: leftPercent(t) }}
          />
        ))}
        {lesson && (
          <div
            data-part="lesson-band"
            className="absolute inset-y-0 w-1 -translate-x-1/2"
            style={{ left: leftPercent(lesson.atMs), backgroundColor: lessonBandColor }}
          />
        )}
      </div>
      <div
        data-part="computed"
        className="absolute inset-x-0 top-[26px] h-1 overflow-hidden rounded-full bg-surface-muted"
      >
        {visibleRanges(computed).map((r) => (
          <div
            key={r.fromMs}
            data-part="computed-range"
            data-from={r.fromMs}
            data-to={r.toMs}
            className="absolute inset-y-0 bg-border-strong"
            style={{ left: leftPercent(r.fromMs), width: widthPercent(r.fromMs, r.toMs) }}
          />
        ))}
      </div>
      {forks.map((f) => (
        <div
          key={f.revision}
          data-part="fork-line"
          className="absolute top-0 h-[30px] w-px -translate-x-1/2"
          style={{ left: leftPercent(f.atMs), backgroundImage: forkDash }}
        />
      ))}
      {highSide &&
        rollupTicks().map((r) => (
          <div
            key={r.day}
            data-part="rollup-tick"
            className="absolute top-[35px] h-1 w-px bg-ink-subtle"
            style={{ left: leftPercent(r.atMs) }}
          />
        ))}
    </div>
  );
});
