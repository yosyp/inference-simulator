// The High-side rollup table (05 §8, §9; K17): what the off-site team receives, one metric at a
// time, replicas down and days across. It sits in the sidebar's collapsible rollup slot.
//
// Layout. The rollup is days × replicas × three metrics, 120 cells on Server B, in a sidebar about
// 350–400 px wide. Showing all three at once needs 15 day columns (about 21 px each) or five
// stacked day sections (40 rows), and both lose the comparison that matters: one replica's row
// across the week. So a picker chooses the metric and the table shows 8 × 5 cells:
// - days run left to right, as on the week timeline and the daily bars;
// - replicas run top to bottom, as on the canvas;
// - requests served is the default, because it is the one metric the charts don't draw as bars,
//   and the only place a failed replica shows on the high side: as a drop in its row (01 §8).
// There is no failure marker and no error count (Q11); the missing signal is the lesson.

import { useId, useMemo, useState } from 'react';
import type { RollupMetric } from '../../charts/index.ts';
import { MISSING, formatCount, formatPercent } from '../../charts/format.ts';
import { replicaLabel } from '../../charts/styles.ts';
import type { RollupRow } from '../../engine/results.ts';
import { DAY_NAMES, SECOND_MS, type DayIndex } from '../../engine/time.ts';
import type { PlaybackStore } from '../../playback/types.ts';
import { SegmentedToggle, type SegmentedOption } from '../primitives/SegmentedToggle.tsx';
import { cx } from '../primitives/util.ts';
import { WEEK, arrivalLabel, dayStatus, type DayStatus } from './delivered.ts';
import { useDeliveredRollup } from './use-delivered-rollup.ts';

export interface RollupMetricSpec {
  /** The picker label. */
  short: string;
  /** The caption and the picker's accessible description. */
  name: string;
  format: (v: number) => string;
}

/**
 * Mean E2E latency in seconds with a fixed decimal, so a column lines up ("6.0 s" over "6.1 s"; the
 * daily bars' readout says "6 s"). Rollup means are seconds long: prompt plus hundreds of tokens.
 */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const s = ms / SECOND_MS;
  return `${Math.abs(s) < 100 ? s.toFixed(1) : Math.round(s)} s`;
}

/** The three rollup metrics (Q11), in picker order. */
export const ROLLUP_METRICS: Record<RollupMetric, RollupMetricSpec> = {
  requestsServed: { short: 'Served', name: 'Requests served', format: formatCount },
  meanE2eMs: { short: 'E2E latency', name: 'Mean end-to-end latency', format: formatSeconds },
  meanNvidiaSmiUtil: {
    short: 'Utilization',
    name: 'Mean GPU utilization (nvidia-smi)',
    format: formatPercent,
  },
};

const METRIC_ORDER: readonly RollupMetric[] = ['requestsServed', 'meanE2eMs', 'meanNvidiaSmiUtil'];

const METRIC_OPTIONS: SegmentedOption<RollupMetric>[] = METRIC_ORDER.map((m) => ({
  value: m,
  label: ROLLUP_METRICS[m].short,
  description: ROLLUP_METRICS[m].name,
}));

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

export const NOT_YET_REPORTED = 'Not yet reported';
export const COMPUTING = 'Computing…';

export interface RollupTableProps {
  store: PlaybackStore;
  /** The metric shown first. Default requestsServed. */
  defaultMetric?: RollupMetric;
  /** Most re-renders per second. Default ROLLUP_MAX_HZ. */
  maxHz?: number;
  className?: string;
}

function arrivedMessage(days: readonly DayIndex[]): string {
  if (days.length === 0) return '';
  const names = days.map((d) => DAY_NAMES[d]);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Rollup arrived for ${list}.`;
}

export function RollupTable({
  store,
  defaultMetric = 'requestsServed',
  maxHz,
  className,
}: RollupTableProps) {
  const view = useDeliveredRollup(store, { maxHz });
  const [metric, setMetric] = useState<RollupMetric>(defaultMetric);
  const noteId = useId();
  const spec = ROLLUP_METRICS[metric];
  const cells = useMemo(() => {
    const m = new Map<string, RollupRow>();
    for (const r of view.rows) m.set(`${r.day}-${r.replica}`, r);
    return m;
  }, [view.rows]);
  const statuses = WEEK.map((d) => dayStatus(view, d));
  const replicas = Array.from({ length: view.replicas }, (_, r) => r);

  // Announce days as their rollup lands (not on mount), like a report arriving.
  const [seen, setSeen] = useState(view.deliveredDays);
  const [announcement, setAnnouncement] = useState('');
  if (seen !== view.deliveredDays) {
    setSeen(view.deliveredDays);
    setAnnouncement(arrivedMessage(view.deliveredDays.filter((d) => !seen.includes(d))));
  }

  return (
    <div data-high-side="rollup-table" className={cx('flex flex-col gap-2', className)}>
      <SegmentedToggle
        label="Rollup metric"
        size="sm"
        options={METRIC_OPTIONS}
        value={metric}
        onChange={setMetric}
        className="self-start"
      />
      <div className="overflow-x-auto">
        <table
          aria-describedby={noteId}
          data-metric={metric}
          className="w-full table-fixed border-separate border-spacing-0 text-xs tabular-nums"
        >
          <caption className="sr-only">{`${spec.name} per replica per day`}</caption>
          <colgroup>
            <col className="w-9" />
            {WEEK.map((d) => (
              <col key={d} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="pb-1 text-left text-2xs font-normal text-ink-subtle">
                <span className="sr-only">Replica</span>
              </th>
              {WEEK.map((d) => (
                <th
                  key={d}
                  scope="col"
                  abbr={DAY_NAMES[d]}
                  data-day={d}
                  data-status={statuses[d]}
                  aria-current={statuses[d] === 'today' ? 'date' : undefined}
                  className={cx(
                    'px-1 pb-1 text-right text-2xs',
                    statuses[d] === 'today' && 'font-semibold text-ink',
                    statuses[d] === 'future' && 'font-normal text-ink-subtle',
                    statuses[d] !== 'today' &&
                      statuses[d] !== 'future' &&
                      'font-medium text-ink-muted',
                  )}
                >
                  {DAY_SHORT[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {replicas.map((r) => (
              <tr key={r} data-replica={r}>
                <th
                  scope="row"
                  className="border-t border-border py-0.5 pr-1 text-left font-medium text-ink-muted"
                >
                  {replicaLabel(r)}
                </th>
                {WEEK.map((d) => {
                  const status = statuses[d]!;
                  if (status === 'delivered') {
                    const row = cells.get(`${d}-${r}`);
                    return (
                      <td
                        key={d}
                        data-cell={`${d}-${r}`}
                        className="border-t border-border px-1 py-0.5 text-right text-ink"
                      >
                        {row ? spec.format(row[metric]) : spec.format(NaN)}
                      </td>
                    );
                  }
                  // A day without data is one cell down its whole column.
                  if (r > 0) return null;
                  return <PendingCell key={d} day={d} status={status} rowSpan={view.replicas} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p id={noteId} className="text-2xs text-ink-subtle">
        Per replica per day. Each day arrives the next day at 12:00.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** "Arrives", "Thu 12:00": the day and time never wrap apart. */
function splitArrival(day: DayIndex): [string, string] {
  const label = arrivalLabel(day);
  const i = label.indexOf(' ');
  return [label.slice(0, i), label.slice(i + 1)];
}

function PendingCell({
  day,
  status,
  rowSpan,
}: {
  day: DayIndex;
  status: Exclude<DayStatus, 'delivered'>;
  rowSpan: number;
}) {
  const [arrives, at] = splitArrival(day);
  return (
    <td
      rowSpan={rowSpan}
      data-pending={day}
      data-status={status}
      className={cx(
        'px-1 py-1 text-center align-middle text-2xs leading-4',
        status !== 'future' &&
          'rounded border border-dashed border-high-side-bar-pending text-ink-muted',
      )}
    >
      {status === 'today' && (
        <>
          <span className="block font-medium text-ink">{NOT_YET_REPORTED}</span>{' '}
          <span className="block">
            {arrives} <span className="whitespace-nowrap">{at}</span>
          </span>
        </>
      )}
      {status === 'awaiting' && (
        <>
          {arrives} <span className="whitespace-nowrap">{at}</span>
        </>
      )}
      {status === 'computing' && COMPUTING}
      {status === 'future' && <span className="sr-only">Later this week</span>}
    </td>
  );
}
