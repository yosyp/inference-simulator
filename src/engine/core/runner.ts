// Day runner factory: builds day runs from a module list (00-build E2; K21; 04 §3).
// E11 wraps createDayRunner(modules) into the Engine (api.ts) and adds sessionPlan.

import type { DayRun, DayRunInput } from '../api.ts';
import type { ResultChunk } from '../results.ts';
import { DAY_MS, dayStartMs, isDayIndex, type SimMs } from '../time.ts';
import { dayStartParams, partitionPatches, samePatchList } from './patches.ts';
import { canonicalJson } from './plain.ts';
import { createQueue } from './queue.ts';
import { buildRegistry } from './registry.ts';
import { openRun } from './run.ts';
import type { CoreState, DayRunner, DayState, EngineModule, RunnerOptions } from './types.ts';

function validateInput(input: DayRunInput): void {
  if (!isDayIndex(input.day)) throw new RangeError(`Day ${input.day} is not a work-week day`);
  const { bucketMs, histBucketMs } = input.config;
  if (!Number.isInteger(bucketMs) || bucketMs <= 0) {
    throw new RangeError(`config.bucketMs ${bucketMs} must be a positive integer`);
  }
  if (!Number.isInteger(histBucketMs) || histBucketMs % bucketMs !== 0) {
    throw new RangeError(`config.histBucketMs ${histBucketMs} must be a multiple of bucketMs`);
  }
  if (DAY_MS % histBucketMs !== 0) {
    throw new RangeError(`config.histBucketMs ${histBucketMs} must divide a day`);
  }
}

function inputKey(input: DayRunInput): string {
  return canonicalJson([input.config, input.calibration]);
}

/**
 * Builds a runner for a fixed module list. Module order is part of determinism: init, hooks, and
 * notice subscribers run in this order.
 */
export function createDayRunner(
  modules: readonly EngineModule[],
  options: RunnerOptions = {},
): DayRunner {
  const reg = buildRegistry(modules);

  return {
    createDayRun(input) {
      validateInput(input);
      const { preDay, inDay } = partitionPatches(input.patches, input.day);
      const params = dayStartParams(input);
      const startMs = dayStartMs(input.day);
      const core: CoreState = {
        day: input.day,
        dayStartMs: startMs,
        dayEndMs: startMs + DAY_MS,
        nowMs: startMs,
        closedToMs: startMs,
        params,
        queue: createQueue(),
        patches: { preDay, inDay, next: 0 },
        inputKey: inputKey(input),
      };
      // Module slices are added by init, in order.
      return openRun(reg, input, { core } as DayState, options, true);
    },

    restoreDayRun(input, checkpoint) {
      validateInput(input);
      if (checkpoint.day !== input.day) {
        throw new Error(`restoreDayRun: checkpoint is for day ${checkpoint.day}, not ${input.day}`);
      }
      const state = structuredClone(checkpoint.state) as DayState | undefined;
      const core = state?.core;
      if (!state || !core || core.day !== input.day || core.nowMs !== checkpoint.atMs) {
        throw new Error('restoreDayRun: checkpoint state does not match its day and time');
      }
      if (core.inputKey !== inputKey(input)) {
        throw new Error('restoreDayRun: config or calibration differs from the checkpointed run');
      }
      const slices = Object.keys(state).filter((k) => k !== 'core');
      const names = modules.map((m) => m.name as string);
      if (slices.length !== names.length || names.some((n) => !slices.includes(n))) {
        throw new Error(
          `restoreDayRun: checkpoint slices [${slices.join(', ')}] do not match modules [${names.join(', ')}]`,
        );
      }
      // Patches dated before the checkpoint are baked into state; they must be the same ones.
      const { preDay, inDay } = partitionPatches(input.patches, input.day);
      const p = core.patches;
      if (!samePatchList(preDay, p.preDay)) {
        throw new Error('restoreDayRun: patches dated before the day differ from the checkpoint');
      }
      const applied = inDay.filter((x) => x.atMs < checkpoint.atMs);
      if (!samePatchList(applied, p.inDay.slice(0, p.next))) {
        throw new Error(
          'restoreDayRun: patches dated before the checkpoint differ from those it applied',
        );
      }
      // Patches at or after the checkpoint come from the new input; this is the fork path.
      p.inDay = inDay;
      return openRun(reg, input, state, options, false);
    },
  };
}

/**
 * Advances `run` to min(untilMs, day end) in steps that end on multiples of stepMs from the day
 * start, and returns one chunk per step. A convenience for headless runs and tests.
 */
export function advanceInSteps(run: DayRun, untilMs: SimMs, stepMs: number): ResultChunk[] {
  if (!(stepMs > 0)) throw new RangeError(`stepMs ${stepMs} must be positive`);
  const startMs = dayStartMs(run.day);
  const end = Math.min(untilMs, startMs + DAY_MS);
  const chunks: ResultChunk[] = [];
  while (run.nowMs < end) {
    const step = Math.floor((run.nowMs - startMs) / stepMs) + 1;
    chunks.push(run.advance(Math.min(end, startMs + step * stepMs)));
  }
  return chunks;
}
