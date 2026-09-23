# Engine core: event queue and day runner

WP E2 (00-build §5). Every engine module (E5 replica, E6 load and client, E7 router, E8 failure, E9 metrics) plugs into this. E11 builds the Engine from it.

The runner simulates one independent day (K21) from a standard morning state. It advances by jumping from event to event (02 §5), checkpoints with `structuredClone`, and restores with different patches to fork (04 §3).

| File | What |
|---|---|
| `types.ts` | `DayState`, `Ctx`, `EngineModule`, `defineModule`, `CoreDayRun`, `DayRunner` |
| `runner.ts` | `createDayRunner(modules)`: `createDayRun` / `restoreDayRun`; `advanceInSteps` |
| `run.ts` | The advance loop, bucket hooks, patch application, checkpoints |
| `queue.ts` | Binary heap of events as plain data, with O(1) cancellation |
| `ids.ts` | `PRIORITY` bands, `KIND_RANGES`, shared `TOPIC`s |
| `level.ts` | Time-weighted levels (KV usage, queue lengths) |
| `patches.ts` | Pre-day and in-day patch split (K21) |
| `chunk.ts` | `emptyChunk`, the stub producer until E9 lands |
| `plain.ts` | `assertPlainData`, `digestState`, `canonicalJson` |
| `toy-model.test.ts` | A complete toy model: the best runnable example |

Import from `../core/index.ts`.

## The model in one paragraph

State is one plain-data object: `state.core` plus one **slice** per module (`state.replica`, `state.load`, ...). A **module** owns a slice, a set of **event kinds** with handlers `(state, ev, ctx) => void`, and optional hooks. Handlers read any slice but write only their own, except through the other module's exported functions. Events carry two numbers, `a` and `b`. `ctx.schedule` returns a **handle**, and `ctx.cancel(handle)` invalidates the event in O(1). A cancelled event never reaches its handler. A **notice** (`ctx.notify(topic, a, b)`) calls every subscriber synchronously; it is for upward and fan-out calls (a first token, a request ending). Tunable parameters in effect live in `state.core.params`; patches change them.

## Worked example

This module is illustrative, not E7's design: a router-signal sampler that copies each replica's outstanding count every `signalRefreshMs`. It shows a slice with its augmentation, init, a self-rescheduling event, reading another slice, `onParams`, a notice, a level flushed at bucket ends, and invariants. `readme-example.test.ts` compiles and runs it, with test slice names.

```ts
// src/engine/router/signals.ts
import {
  NO_EVENT, PRIORITY, TOPIC, createLevel, defineModule, setLevel, takeLevelMean,
  type Ctx, type DayState, type Level,
} from '../core/index.ts';
import { REPLICA_STATE } from '../results.ts';

export interface SignalSlice {
  /** Outstanding count per replica as the router last saw it (stale by design, 02 §7). */
  seen: Float64Array;
  ready: Uint8Array;
  /** Handle of the next refresh. Handles need 53 bits: Float64Array or number[], never Int32Array. */
  refreshEv: number;
  staleness: Level;
}

// 1. Add the slice to DayState. Augment the declaring file, not the index barrel.
declare module '../core/types.ts' {
  interface DayState {
    signals: SignalSlice;
  }
}

// 2. Event kinds come from this module's KIND_RANGES range (router: 200-299).
export const EV_REFRESH = 200;

function refresh(state: DayState, ctx: Ctx): void {
  const s = state.signals;
  const replicas = state.replica; // read another module's slice; don't write it
  for (let r = 0; r < s.seen.length; r++) s.seen[r] = replicas.outstanding[r]!;
  setLevel(s.staleness, ctx.nowMs, 0);
  // Payloads are numbers. Returns NO_EVENT if the time falls after the day's end.
  s.refreshEv = ctx.schedule(ctx.nowMs + state.core.params.signalRefreshMs, EV_REFRESH);
}

export const signalsModule = defineModule({
  name: 'signals',
  // 3. The standard morning state. params already include 'set' patches dated before the day.
  init(_state, ctx) {
    const n = ctx.input.config.replicas;
    const refreshEv = ctx.schedule(ctx.dayStartMs, EV_REFRESH);
    return {
      seen: new Float64Array(n),
      ready: new Uint8Array(n).fill(1),
      refreshEv,
      staleness: createLevel(ctx.nowMs),
    };
  },
  events: [{ kind: EV_REFRESH, name: 'signals.refresh', priority: PRIORITY.router, handle: (state, _ev, ctx) => refresh(state, ctx) }],
  // 4. A lasting parameter changed at ctx.nowMs: move the pending refresh.
  onParams(state, changes, ctx) {
    if (changes.signalRefreshMs === undefined) return;
    const s = state.signals;
    s.refreshEv = ctx.reschedule(s.refreshEv, ctx.nowMs + changes.signalRefreshMs, EV_REFRESH);
  },
  // 5. Upward notices: E8 announces replica state changes; nobody imports anybody.
  notices: [
    {
      topic: TOPIC.replicaState,
      handle(state, n) {
        state.signals.ready[n.a] = n.b === REPLICA_STATE.ready ? 1 : 0;
      },
    },
  ],
  // 6. Levels integrate lazily; flush them at bucket ends (E9 will own this in practice).
  onBucketEnd(state, boundaryMs) {
    takeLevelMean(state.signals.staleness, boundaryMs);
  },
  assertInvariants(state, ctx) {
    if (!ctx.isPending(state.signals.refreshEv) && state.signals.refreshEv !== NO_EVENT) {
      throw new Error('signals: lost the refresh event');
    }
  },
});
```

E11 then does:

```ts
const runner = createDayRunner([loadModule, routerModule, replicaModule, failureModule, metricsModule]);
export const engine: Engine = { ...runner, sessionPlan };
```

## API

```ts
createDayRunner(modules: readonly EngineModule[], options?: RunnerOptions): DayRunner
interface DayRunner {
  createDayRun(input: DayRunInput): CoreDayRun;
  restoreDayRun(input: DayRunInput, checkpoint: DayCheckpoint): CoreDayRun;
}
interface CoreDayRun extends DayRun {           // DayRun from api.ts: day, nowMs, done, advance, checkpoint
  readonly state: DayState;                     // live; E11 reads module outputs (e.g. rollup) here
  readonly dayEndMs: SimMs;
  assertInvariants(): void;                     // core + every module + plain-data walk
}
interface RunnerOptions {
  trace?: (ev: Readonly<EventView>, state: DayState) => void;  // before each dispatch; patches have kind PATCH_KIND (0)
  assertEveryEvent?: boolean;                   // core + module invariants after every event (tests)
}
advanceInSteps(run: DayRun, untilMs: SimMs, stepMs: number): ResultChunk[]

interface EngineModule<N extends SliceName> {
  readonly name: N;                                         // slice key; 'core' is reserved
  init(state: DayState, ctx: Ctx): DayState[N];             // may schedule; later slices don't exist yet
  readonly events?: readonly EventSpec[];                   // { kind, name, priority, handle }
  readonly notices?: readonly NoticeSpec[];                 // { topic, handle }
  onParams?(state, changes: Partial<TunableParams>, ctx): void;   // after state.core.params updated
  onInjected?(state, event: InjectedEvent, ctx): void;      // every module sees every injected event
  onBucketEnd?(state, boundaryMs: SimMs, ctx): void;        // ctx.nowMs === boundaryMs
  produceChunk?(state, span: ChunkSpan, ctx): ResultChunk;  // at most one module (E9)
  assertInvariants?(state, ctx): void;
}
type EventHandler  = (state: DayState, ev: Readonly<EventView>,  ctx: Ctx) => void;  // ev: { atMs, kind, a, b, handle }
type NoticeHandler = (state: DayState, n: Readonly<NoticeView>, ctx: Ctx) => void;   // n: { topic, a, b }

interface Ctx {
  readonly nowMs: SimMs;
  readonly input: DayRunInput;         // config, calibration, day, detail, trackedAnalyst
  readonly dayStartMs: SimMs;
  readonly dayEndMs: SimMs;
  schedule(atMs: SimMs, kind: number, a?: number, b?: number): EventHandle;
  cancel(handle: EventHandle): boolean;
  reschedule(handle: EventHandle, atMs: SimMs, kind: number, a?: number, b?: number): EventHandle;
  isPending(handle: EventHandle): boolean;
  notify(topic: number, a?: number, b?: number): void;
}
```

## Rules

### Time and the boundary rule

`advance(untilMs)` with `end = min(untilMs, dayEndMs)`:

1. Take the earliest of the next pending patch and the next queued event. A patch wins a tie. Stop once that time is `>= end`. **Events and patches exactly at `end` stay pending.**
2. Before anything at time `t` runs, close every bucket boundary `b <= t` in order: `onBucketEnd(state, b)` runs with `nowMs = b`, after every event before `b` and before any event at `b`. An event at exactly a boundary lands in the new bucket.
3. Set `nowMs = t`, then apply the patch or dispatch the event.
4. Close boundaries `<= end`, set `nowMs = end`, and build the chunk for `[fromMs, end)`.

So after `advance(T)`, every event before `T` has run and none at or after `T` has. That is the checkpoint invariant. The day is `[dayStartMs, dayStartMs + DAY_MS)`. `schedule` at or after `dayEndMs` returns `NO_EVENT` and queues nothing, so no event ever runs at the day end. `advance` past the end clamps, and `done` becomes true. Moving backwards throws. Splitting one advance into many runs the same handlers in the same order on the same state; the toy model proves it with a full-state digest.

`schedule` throws for `atMs < nowMs` or NaN. Event-jumping math can land a hair before now through float error, so clamp: `ctx.nowMs + Math.max(0, remaining) * rate`. `atMs === nowMs` is allowed; the event runs later in the same instant.

### Ordering at equal times

Order is `(atMs, priority, push sequence)`: a strict total order, independent of heap layout. Use the `PRIORITY` bands. A module may add 0–9 to order its own kinds.

| Band | Value | Kinds |
|---|---|---|
| (patches) | first | Applied by the core before any event at their instant |
| `infra` | 10 | E8: crash, mark-down, load phases, Ready |
| `engine` | 20 | E5: step-span ends (first token, finish, prefill chunk, KV exhaustion) |
| `client` | 30 | E6: timeouts. After `engine`, so a first token exactly at the deadline counts (K8) |
| `router` | 40 | E7: signal refresh, dispatch after router overhead |
| `arrival` | 50 | E6: session start, next turn, retry |
| `late` | 90 | Anything that must see the instant settled |

### Kinds and topics

Kinds and topics are integers in `[1, 1024)`. Each module takes them from its own range, and the runner rejects duplicate kinds when it is built.

| Range | Owner |
|---|---|
| 1–99 | core (shared topics below) |
| 100–199 | load and client (E6) |
| 200–299 | router (E7) |
| 300–399 | replica (E5) |
| 400–499 | failure (E8) |
| 500–599 | metrics (E9) |
| 900–1023 | tests |

Schedule only your own kinds. Topics are shared: anyone may emit or listen. The core defines the request-lifecycle topics (02 §3):

| Topic | Payload | Emitted by |
|---|---|---|
| `TOPIC.firstToken` | a = RequestId, b = ReplicaId | E5 |
| `TOPIC.requestEnded` | a = RequestId, b = `OUTCOME` code (results.ts) | Whichever module ends the request, exactly once |
| `TOPIC.replicaState` | a = ReplicaId, b = `REPLICA_STATE` code | E8 |

Add module-specific topics in your own range.

### Payloads and handles

An event carries `a` and `b`, both numbers (stored in typed arrays; no allocation). For more data, keep it in your slice and pass an index. `ev` and notice objects are reused, so don't keep them.

A handle is an opaque non-negative number below 2^53. Store it in a `Float64Array` or `number[]`, never `Int32Array`. `NO_EVENT` (-1) means nothing is scheduled. Cancelling `NO_EVENT`, a fired handle, or an already-cancelled handle is a no-op that returns false. The usual pattern for "my next event", such as a replica's next step-span end, is:

```ts
r.stepEv = ctx.reschedule(r.stepEv, nextEventMs, EV_STEP_END, replica);
```

In the handler, set the stored handle back to `NO_EVENT` if you track it.

### Calling other modules

- **Downward (you know the callee):** call a plain function the callee exports, with the signature `(state, ctx, ...args)`, e.g. `enqueueRequest(state, ctx, replica, request)`. It mutates the callee's slice and may schedule its kinds. The router enqueues onto a replica this way.
- **Upward or fan-out (the callee shouldn't know who listens):** `ctx.notify(topic, a, b)`. Subscribers run now, synchronously, in module-list order, and may notify further. For example, the replica announces a first token, and the client cancels its timeout.
- Slices are read-only to other modules; write only through the owner's functions.
- `init` runs in module order, so don't notify or call into later modules from `init`.

### Parameters and patches (K21)

- `state.core.params` holds the tunable parameters in effect now. Read them at the moment of use. If you cache a derived value, update it in `onParams`.
- At day creation, patches are sorted by `atMs` (ties keep input order). 'set' patches dated before the day are applied into `params` before any `init`, so `onParams` doesn't run for them. Patches dated in `[dayStartMs, dayEndMs)`, of either kind, are applied at their `atMs`, before any event at that instant. That includes a 'set' at the day's first instant. 'event' patches from other days and 'set' patches from later days are ignored. `dayStartParams(input)` returns the parameters `init` will see, without running the day (e.g. for E6's `sessionPlan`).
- A 'set' writes its defined values into `params`; unknown keys throw. Then `onParams(state, changes, ctx)` runs in every module. An 'event' calls `onInjected(state, event, ctx)` in every module, and each module acts on the `type`s it owns.
- Patches are not queued events, so they consume no sequence numbers. A fork with different patches therefore produces the same handles and state as a fresh run with those patches.

### Checkpoints and forks

- `checkpoint()` returns `{ day, atMs: nowMs, state: structuredClone(state) }`. Take one between advances, at any time.
- `restoreDayRun(input, cp)` clones `cp.state` (a checkpoint can be restored many times) and checks the following, throwing on any mismatch:
  - config and calibration are unchanged (canonical JSON);
  - the module list matches the slices;
  - the pre-day 'set' patches and the in-day patches dated before `cp.atMs` equal the ones already applied.
- Patches dated at or after `cp.atMs` come from the new input. This is the fork path. For a fork at `t`, E11 restores the checkpoint at or before the cut, advances silently to the cut, then streams on. The patch applies at `t`.
- `input.detail` and `input.trackedAnalyst` may differ on restore (detail re-simulation, tracking changes). They may change what is recorded, never the dynamics.

### Chunks and metrics (E9)

- `advance` returns one chunk per call. The caller picks the cadence. Stepping to multiples of `histBucketMs` keeps chunks aligned with fork cuts and checkpoints (a suggestion for E11). `advanceInSteps` does aligned steps for headless runs.
- One module may define `produceChunk(state, span, ctx)`. The span has `fromMs` and `toMs` (the advance) and `bucketsFromMs` and `bucketsToMs` (whole scalar buckets completed in it; histogram buckets end on the multiples of `histBucketMs` among them). It must not change anything handlers read, because chunk calls fall at different times in split and unsplit runs. After the day ends it can be called with `fromMs === toMs`.
- Without a producer, `emptyChunk` returns zero-filled scalar and histogram blocks covering exactly the completed buckets, empty records in the input's `detail` scope, and no replica events.
- The last bucket closes at `dayEndMs` (`bucketMs` divides `histBucketMs`, which divides `DAY_MS`; the runner validates both).

### Time-weighted levels

There is no per-event time hook, which would cost O(events × modules). Use a `Level` in your slice: call `setLevel` or `addLevel` when the value changes (O(1); the helper integrates value × time since the last change), and `takeLevelMean(level, boundaryMs)` in `onBucketEnd` to get the bucket's time-weighted mean. Read `level.max` before the take if you need the bucket max. The same pattern splits anything accrued over a span, such as busy time or FLOPs, at bucket boundaries: at `onBucketEnd`, account the part of the span up to the boundary.

### Determinism and plain data

- State is plain data: objects, arrays, typed arrays, Maps, Sets, numbers, strings. No functions, class instances, accessors, or symbols. `run.assertInvariants()` walks the state and names the offending path.
- No wall clock, no `Math.random` (use E1's keyed RNG), no iteration order that depends on anything but state. Map and Set iterate in insertion order, which is fine.
- Module order is part of determinism: `init`, hooks, and notice subscribers run in list order.
- Derive constants from `ctx.input` rather than storing closures. Nothing may carry from one day to the next.
- A handler that throws leaves the run unusable. Later `advance` and `checkpoint` calls throw.

### Testing your module

- Run it inside a runner with `assertEveryEvent: true`, and call `run.assertInvariants()` at checkpoints (00-build §7.1).
- `digestState(value)` gives a stable 64-bit digest of plain data, to compare runs (checkpoint vs uninterrupted, fork vs fresh). `trace` records every dispatch, to find the first divergent event (E10).
- Test-only slices augment `DayState` too. Prefix them with your WP id (`e5probe`) so test files don't collide.

## Performance

Measured in Node 22 under Vitest on the build host. `CORE_BENCH=1 pnpm test src/engine/core --reporter=verbose --silent=false` prints the figures.

| Measure | Result |
|---|---|
| Queue push + pop, hold model, heap of 100 / 1k / 10k / 100k | 7.6M / 8.4M / 7.0M / 5.4M ops/s |
| Runner dispatch, 64 entities, one cancel + reschedule per event | ~2.0M events/s |
| Toy model day (4.8k jobs, 9.6k events, 8.6k cancellations), including its own work | < 50 ms |

A Server B day at knee load is roughly 2–3M events (02 §5), so the core's share is on the order of a second. The modules' work will dominate.
