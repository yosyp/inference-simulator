// High-side integration (00-build U7; 01 §8; 05 §8, §9). X1 mounts <RollupTable store={store} />
// in the Sidebar's `rollup` slot. ChartStack (U4) and WeekTimeline (U5) need nothing from here:
// ChartStack's own delivery filter is the rule in delivered.ts, and consistency.test.tsx holds
// the three surfaces to it.

export {
  COMPUTING,
  NOT_YET_REPORTED,
  ROLLUP_METRICS,
  RollupTable,
  formatSeconds,
  type RollupMetricSpec,
  type RollupTableProps,
} from './RollupTable.tsx';
export {
  WEEK,
  arrivalLabel,
  dayAtPlayhead,
  dayStatus,
  deliveredRollupAt,
  rollupRowsOf,
  sameDelivered,
  type DayStatus,
  type DeliveredRollup,
} from './delivered.ts';
export {
  ROLLUP_MAX_HZ,
  selectDeliveredRollup,
  useDeliveredRollup,
  type DeliveredRollupOptions,
} from './use-delivered-rollup.ts';
