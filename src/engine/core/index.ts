// Public surface of the event core and day runner (00-build E2). See README.md.
// Augment DayState from './types.ts' (the declaring file), not from this barrel.

export { KIND_RANGES, MAX_KIND, MAX_TOPIC, PATCH_KIND, PRIORITY, TOPIC } from './ids.ts';
export { addLevel, createLevel, setLevel, takeLevelMean, type Level } from './level.ts';
export { applySetChanges, dayStartParams, partitionPatches, type DayPatches } from './patches.ts';
export { assertPlainData, canonicalJson, digestState } from './plain.ts';
export { NO_EVENT, type EventHandle, type EventView } from './queue.ts';
export { emptyChunk } from './chunk.ts';
export { advanceInSteps, createDayRunner } from './runner.ts';
export {
  defineModule,
  type ChunkSpan,
  type CoreDayRun,
  type CoreState,
  type Ctx,
  type DayRunner,
  type DayState,
  type EngineModule,
  type EventHandler,
  type EventSpec,
  type NoticeHandler,
  type NoticeSpec,
  type NoticeView,
  type PatchState,
  type RunnerOptions,
  type SliceName,
} from './types.ts';
