// Scenario (tab) definition (docs/00-build.md §4; 01 §6, 02 §10, 05 §3–§8). Frozen at M0.
// Scenarios live on the main thread and may hold functions (status templates). Only
// toWorkerScenario(...) crosses to the worker.

import type { PatchTemplate, SimConfig, TunableParams, Patch } from '../engine/api.ts';
import type { SimMs } from '../engine/time.ts';
import type { StatusSnapshot } from '../playback/types.ts';
import type { TrackedAnalystRule, WorkerScenario } from '../worker/protocol.ts';

export type TabId =
  'long-prompt' | 'knee' | 'kv-exhaustion' | 'routing' | 'fail-recover' | 'retry-storm';

export type Chart3Kind = 'utilization' | 'perReplicaLoad' | 'offeredVsAdmitted';

export interface Preset {
  name: '1 GPU' | '2 replicas' | 'Server A' | 'Server B';
  replicas: 1 | 2 | 4 | 8;
  /** Extrapolated presets carry an on-screen label (01 §7). */
  basis: 'measured' | 'extrapolated';
}

type DrawerControl<V> =
  | { kind: 'select'; options: readonly { value: V; label: string }[] }
  | { kind: 'range'; min: number; max: number; step: number; unit?: string }
  | { kind: 'toggle'; off: V; on: V };

/** One drawer control; every change forks at the playhead with a 'set' patch (05 §4). */
export type DrawerParam = {
  [K in keyof TunableParams]: {
    param: K;
    label: string;
    help?: string;
    control: DrawerControl<TunableParams[K]>;
  };
}[keyof TunableParams];

export interface StatusTemplate {
  id: string;
  /** Higher wins when several match. */
  priority: number;
  /** Returns the status line, or null when the template does not apply. */
  render: (snapshot: StatusSnapshot) => string | null;
}

export interface Scenario {
  id: TabId;
  tab: 1 | 2 | 3 | 4 | 5 | 6;
  /** Tab label, e.g. "Long prompt". */
  title: string;
  preset: Preset;
  sim: SimConfig;
  /** The baseline week's patches; the lesson moment is one of them (K1). */
  baselinePatches: Patch[];
  /** Monday to Thursday (K2). */
  lessonMoment: { atMs: SimMs; label: string };
  /** Where the tab opens, paused (K16). */
  entry: { atMs: SimMs; speed: number };
  /** Re-applies the lesson moment at the playhead (K1). */
  trigger: { label: string; patch: PatchTemplate };
  /** Tabs 4 and 6 only (Q14). */
  namedFix?: { label: string; changes: Partial<TunableParams> };
  tracked: TrackedAnalystRule;
  chart3: Chart3Kind;
  drawer: DrawerParam[];
  copy: {
    whatToWatch: string[];
    /** Two or three suggestions for a self-serve visitor (K17). */
    tryThis: string[];
  };
  statusTemplates: StatusTemplate[];
  /** Shown under the title in the sidebar: what the tab teaches, and the conclusion to take away. */
  lesson?: { summary: string; takeaway: string };
  /** Default chart window span in ms, centred on the lesson moment (U4); the whole shift day if unset. */
  chartWindowMs?: number;
}

export function toWorkerScenario(s: Scenario): WorkerScenario {
  return { config: s.sim, baselinePatches: s.baselinePatches, tracked: s.tracked };
}
