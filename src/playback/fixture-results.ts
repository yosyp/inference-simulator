// A stand-in ResultsStore until U8's createResultsStore lands: the analytic fake index from
// src/fixtures for queries, plus a log of every write. It stores nothing; `computed()` and
// `version` do follow the writes so renderers see progress.

import type { ResultChunk, RollupRow } from '../engine/results.ts';
import type { DayIndex, SimMs } from '../engine/time.ts';
import { createFakeIndex } from '../fixtures/fake-index.ts';
import type { FixtureOptions } from '../fixtures/synthetic.ts';
import type { ComputedRange } from '../worker/protocol.ts';
import type { ResultsIndex, ResultsStore } from './types.ts';

export type ResultsCall =
  | { method: 'reset'; replicas: number }
  | { method: 'addChunk'; chunk: ResultChunk }
  | { method: 'addDetail'; chunk: ResultChunk }
  | { method: 'addTrace'; day: DayIndex; chunk: ResultChunk }
  | { method: 'addRollup'; day: DayIndex; rows: readonly RollupRow[] }
  | { method: 'setComputed'; ranges: readonly ComputedRange[] }
  | { method: 'cut'; day: DayIndex; cutMs: SimMs; lasting: boolean };

export interface FixtureResultsStore extends ResultsStore {
  readonly calls: ResultsCall[];
  /** Calls of one method, narrowed. */
  callsOf<M extends ResultsCall['method']>(method: M): Extract<ResultsCall, { method: M }>[];
}

export function createFixtureResultsStore(
  replicas: number,
  fixture: Omit<FixtureOptions, 'replicas'> = {},
): FixtureResultsStore {
  const calls: ResultsCall[] = [];
  let version = 0;
  let computed: readonly ComputedRange[] = [];
  let fake = createFakeIndex({ ...fixture, replicas });

  const index: ResultsIndex = {
    get version() {
      return version;
    },
    get replicas() {
      return fake.replicas;
    },
    computed: () => computed,
    scalarSeries: (...args) => fake.scalarSeries(...args),
    quantileSeries: (...args) => fake.quantileSeries(...args),
    requestPoints: (...args) => fake.requestPoints(...args),
    sceneAt: (...args) => fake.sceneAt(...args),
    statusAt: (...args) => fake.statusAt(...args),
    rollup: () => fake.rollup(),
    completedDays: () => fake.completedDays(),
  };

  const record = (call: ResultsCall) => {
    calls.push(call);
    version++;
  };

  return {
    index,
    calls,
    callsOf: <M extends ResultsCall['method']>(method: M) =>
      calls.filter((c): c is Extract<ResultsCall, { method: M }> => c.method === method),
    reset(n) {
      fake = createFakeIndex({ ...fixture, replicas: n });
      computed = [];
      record({ method: 'reset', replicas: n });
    },
    addChunk: (chunk) => record({ method: 'addChunk', chunk }),
    addDetail: (chunk) => record({ method: 'addDetail', chunk }),
    addTrace: (day, chunk) => record({ method: 'addTrace', day, chunk }),
    addRollup: (day, rows) => record({ method: 'addRollup', day, rows }),
    setComputed(ranges) {
      computed = ranges;
      record({ method: 'setComputed', ranges });
    },
    cut: (day, cutMs, lasting) => record({ method: 'cut', day, cutMs, lasting }),
  };
}
