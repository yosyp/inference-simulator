// The three stacked charts (05 §6): latency, memory, and the tab's chart 3, on one shared time axis
// and window, vertically aligned. Reads the playback store through a throttled selector and draws
// either mode: Live time series, or High-side daily bars and empty panels (05 §9), with a tweened
// collapse between them (K13). See time-window.ts for the window and zoom rules.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { calibration as defaultCalibration } from '../data/calibration.ts';
import type { Calibration } from '../engine/calibration.ts';
import type { RollupRow } from '../engine/results.ts';
import { DAY_MS, WEEK_DAYS, type DayIndex } from '../engine/time.ts';
import type { Mode, PlaybackState, PlaybackStore, ResultsIndex } from '../playback/types.ts';
import { usePlaybackSelector } from '../playback/use-playback-selector.ts';
import type { Chart3Kind } from '../scenarios/schema.ts';
import { usePrefersReducedMotion } from '../ui/theme/index.ts';
import type { LoadMetric } from './chart3-panels.ts';
import { collapseDomain, collapsePhases, useCollapseProgress } from './collapse.ts';
import { DailyBars } from './DailyBars.tsx';
import { formatSpan } from './format.ts';
import { FALLBACK_WIDTH_PX, PLOT_INSET, STACK_ROWS, stackGeometry } from './layout.ts';
import { LineChart, type LessonMoment } from './LineChart.tsx';
import { buildLivePanels } from './live-panels.ts';
import { NotCollectedPanel } from './NotCollectedPanel.tsx';
import { CHART_TITLES } from './panel-types.ts';
import { readoutSentence } from './readout.ts';
import {
  canZoomIn,
  canZoomOut,
  resolveWindow,
  timeTicks,
  windowLabel,
  zoomIn,
  zoomOut,
  type ChartView,
  type Shift,
} from './time-window.ts';
import { TimeAxis } from './TimeAxis.tsx';
import { useElementWidth } from './use-element-width.ts';
import { ZoomControls } from './ZoomControls.tsx';

export interface ChartStackProps {
  store: PlaybackStore;
  chart3: Chart3Kind;
  /** The scenario's analyst shift (SimConfig.shift): the default window is the playhead's shift. */
  shift: Shift;
  /** Marked on every chart (K26); labelled on the top one. */
  lessonMoment?: LessonMoment | null;
  /** High-side rows to draw (U7 filters by delivery). Default: rows delivered by the playhead. */
  rollupRows?: readonly RollupRow[];
  /** Peak FLOPs for compute utilization. Default: src/data/calibration.ts. */
  calibration?: Calibration;
  /** perReplicaLoad: router view (default) or engine view. */
  loadMetric?: LoadMetric;
  /** Fixed width in px; otherwise the container is measured. */
  width?: number;
  /** Total height. Default 3 × layout.chartHeightPx (396 px). */
  height?: number;
  /** Most store-driven re-renders per second. Default 10. */
  maxHz?: number;
}

interface ChartSnapshot {
  playheadMs: number;
  mode: Mode;
  forks: PlaybackState['forks'];
  version: number;
  replicas: number;
}

function selectCharts(s: PlaybackState, index: ResultsIndex): ChartSnapshot {
  return {
    playheadMs: s.playheadMs,
    mode: s.mode,
    forks: s.forks,
    version: index.version,
    replicas: index.replicas,
  };
}

function sameSnapshot(a: ChartSnapshot, b: ChartSnapshot): boolean {
  return (
    a.playheadMs === b.playheadMs &&
    a.mode === b.mode &&
    a.forks === b.forks &&
    a.version === b.version &&
    a.replicas === b.replicas
  );
}

/** Ctrl/⌘ + wheel delta that makes one zoom step. */
const WHEEL_STEP = 60;
const TICK_TARGET_PX = 90;

/** Days up to the playhead's whose rollup hasn't arrived: the current day, and yesterday before 12:00. */
export function pendingDaysAt(playheadMs: number, rows: readonly RollupRow[]): DayIndex[] {
  const today = Math.min(WEEK_DAYS - 1, Math.max(0, Math.floor(playheadMs / DAY_MS)));
  const out: DayIndex[] = [];
  for (let d = 0; d <= today; d++) {
    if (!rows.some((r) => r.day === d)) out.push(d as DayIndex);
  }
  return out;
}

export function ChartStack({
  store,
  chart3,
  shift,
  lessonMoment = null,
  rollupRows,
  calibration = defaultCalibration,
  loadMetric = 'outstanding',
  width,
  height,
  maxHz,
}: ChartStackProps) {
  const snap = usePlaybackSelector(store, selectCharts, { maxHz, equals: sameSnapshot });
  const index = store.index;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const measured = useElementWidth(container);
  const geo = stackGeometry(width ?? measured ?? FALLBACK_WIDTH_PX, height);
  const [view, setView] = useState<ChartView | null>(null);
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const keysId = useId();
  const reduced = usePrefersReducedMotion();
  const collapse = useCollapseProgress(snap.mode === 'highSide' ? 1 : 0, reduced);
  const phases = collapsePhases(collapse);
  const live = phases.liveData > 0;
  const interactive = collapse === 0;

  const playheadMs = snap.playheadMs;
  const win = resolveWindow(view, playheadMs, shift);
  const span = win.toMs - win.fromMs;
  const pixelMs = span / geo.columns;
  // Data stops at the playhead, quantized to whole pixels so panels rebuild once per pixel of play.
  const visibleToMs = Math.min(
    win.toMs,
    win.fromMs + Math.floor((playheadMs - win.fromMs) / pixelMs) * pixelMs,
  );
  const visibleEnd = Math.max(win.fromMs, Math.min(win.toMs, playheadMs));

  const panels = useMemo(
    () =>
      live
        ? buildLivePanels({
            index,
            version: snap.version,
            fromMs: win.fromMs,
            toMs: win.toMs,
            columns: geo.columns,
            visibleToMs,
            chart3,
            calibration,
            loadMetric,
          })
        : null,
    [
      live,
      index,
      snap.version,
      win.fromMs,
      win.toMs,
      geo.columns,
      visibleToMs,
      chart3,
      calibration,
      loadMetric,
    ],
  );

  const rows =
    rollupRows ??
    (phases.highSide > 0 ? index.rollup().filter((r) => r.deliveredAtMs <= playheadMs) : []);
  const pending = pendingDaysAt(playheadMs, rows);
  const shownCursor =
    cursorMs !== null && cursorMs >= win.fromMs && cursorMs <= visibleEnd ? cursorMs : null;
  const xDomain = collapseDomain(win, phases.morph);
  const ticks = timeTicks(win, Math.max(2, Math.floor(geo.plotWidth / TICK_TARGET_PX)));

  // Zoom. Buttons and keys keep the playhead in place; ctrl/⌘ + wheel keeps the pointer's time.
  const zoom = (dir: 'in' | 'out', focusMs?: number) =>
    setView((v) => {
      const w = resolveWindow(v, playheadMs, shift);
      const f =
        focusMs ??
        (playheadMs >= w.fromMs && playheadMs <= w.toMs ? playheadMs : (w.fromMs + w.toMs) / 2);
      return dir === 'in' ? zoomIn(v, w, f, shift) : zoomOut(v, w, f, shift);
    });
  const latest = useRef({ playheadMs, shift, plotWidth: geo.plotWidth });
  useEffect(() => {
    latest.current = { playheadMs, shift, plotWidth: geo.plotWidth };
  });
  useEffect(() => {
    if (!container) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < WHEEL_STEP) return;
      const dir = acc < 0 ? 'in' : 'out';
      acc = 0;
      const { playheadMs: t, shift: sh, plotWidth } = latest.current;
      const rel =
        (e.clientX - container.getBoundingClientRect().left - PLOT_INSET.left) / plotWidth;
      setView((v) => {
        const w = resolveWindow(v, t, sh);
        const f = w.fromMs + Math.min(1, Math.max(0, rel)) * (w.toMs - w.fromMs);
        return dir === 'in' ? zoomIn(v, w, f, sh) : zoomOut(v, w, f, sh);
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [container]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!panels || !interactive || e.target !== e.currentTarget) return;
    const step = e.shiftKey ? span / 12 : span / 60;
    const from = shownCursor ?? visibleEnd;
    let next: number | null | undefined;
    switch (e.key) {
      case 'ArrowLeft':
        next = Math.max(win.fromMs, from - step);
        break;
      case 'ArrowRight':
        next = Math.min(visibleEnd, from + step);
        break;
      case 'Home':
        next = win.fromMs;
        break;
      case 'End':
        next = visibleEnd;
        break;
      case 'Escape':
        next = null;
        break;
      case '+':
      case '=':
        zoom('in');
        break;
      case '-':
      case '_':
        zoom('out');
        break;
      case '0':
        setView(null);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next === undefined) return;
    setCursorMs(next);
    setSpoken(next === null ? '' : panels.map((p) => readoutSentence(p, next, pixelMs)).join(' '));
  };

  const highSlots: ReactNode[] = [
    <DailyBars
      key="bars1"
      rows={rows}
      metric="meanE2eMs"
      replicas={snap.replicas}
      width={geo.width}
      height={geo.chartHeight}
      title={CHART_TITLES.latency}
      pendingDays={pending}
      progress={phases.highSide}
    />,
    <NotCollectedPanel key="empty2" title={CHART_TITLES.memory} height={geo.chartHeight} />,
    chart3 === 'utilization' ? (
      <DailyBars
        key="bars3"
        rows={rows}
        metric="meanNvidiaSmiUtil"
        replicas={snap.replicas}
        width={geo.width}
        height={geo.chartHeight}
        title={CHART_TITLES.utilization}
        pendingDays={pending}
        progress={phases.highSide}
      />
    ) : (
      <NotCollectedPanel key="empty3" title={CHART_TITLES[chart3]} height={geo.chartHeight} />
    ),
  ];

  return (
    <div
      ref={setContainer}
      role="group"
      aria-label="Charts"
      aria-describedby={interactive ? keysId : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={onKeyDown}
      data-mode={snap.mode}
      data-collapse={collapse.toFixed(3)}
      className="relative bg-surface select-none"
      style={{ height: geo.totalHeight }}
    >
      <div
        className="flex items-center gap-2 px-2 text-2xs text-ink-muted"
        style={{ height: STACK_ROWS.toolbarPx }}
      >
        {phases.liveChrome > 0 ? (
          <>
            <span className="font-medium text-ink tabular-nums" data-window-label="">
              {windowLabel(win)}
            </span>
            <span>{formatSpan(span)}</span>
            <span className="ml-auto hidden xl:inline">Ctrl + scroll to zoom</span>
            <ZoomControls
              className="ml-auto xl:ml-2"
              canIn={canZoomIn(win, shift)}
              canOut={canZoomOut(view)}
              onIn={() => zoom('in')}
              onOut={() => zoom('out')}
              onReset={() => setView(null)}
            />
          </>
        ) : (
          <span className="font-medium text-ink">
            Daily rollups per replica, as the high side receives them
          </span>
        )}
      </div>
      {[0, 1, 2].map((slot) => (
        <div key={slot} className="relative" style={{ height: geo.chartHeight }} data-slot={slot}>
          {panels && (
            <div aria-hidden={collapse > 0 || undefined}>
              <LineChart
                panel={panels[slot]!}
                geometry={geo}
                xDomain={xDomain}
                markerRange={[win.fromMs, win.toMs]}
                playheadMs={playheadMs}
                forks={snap.forks}
                lessonMoment={lessonMoment}
                cursorMs={shownCursor}
                markerLabels={slot === 0}
                gridTimes={ticks}
                morph={phases.morph}
                chromeOpacity={phases.liveChrome}
                dataOpacity={phases.liveData}
                onCursor={interactive ? setCursorMs : undefined}
              />
            </div>
          )}
          {phases.highSide > 0 && (
            <div
              className="absolute inset-0"
              style={phases.highSide < 1 ? { opacity: phases.highSide } : undefined}
              aria-hidden={collapse < 1 || undefined}
            >
              {highSlots[slot]}
            </div>
          )}
        </div>
      ))}
      <TimeAxis
        width={geo.width}
        plotWidth={geo.plotWidth}
        xDomain={xDomain}
        ticks={ticks}
        cursorMs={interactive ? shownCursor : null}
        clockOpacity={phases.liveChrome}
        dayOpacity={phases.highSide}
      />
      <p id={keysId} className="sr-only">
        Left and right arrows read values at a time; Home and End jump; plus and minus zoom; 0
        resets the zoom.
      </p>
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
    </div>
  );
}
