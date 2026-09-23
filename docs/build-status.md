# Build status

Only the integrator edits this file (00-build §6). Status: todo · running · review · merged.

| WP | Status | Branch | Notes |
|---|---|---|---|
| F1 Scaffold | merged | main | Vite 8, React 19, TS 6.0 (typescript-eslint doesn't support TS 7 yet), Tailwind 4, Vitest 5, ESLint 10, pnpm 9 |
| F2 Contracts | merged | main | Contracts in §4; provisional calibration; fixtures in `src/fixtures/` |
| S1 Scale spike | merged | main | Report: `docs/spikes/s1-scale.md`. G1 decided K28 (storage), K29 (sparse histograms, 2× bins), K30 (P1 3 s, early A/B entry). |
| E1 Keyed RNG | merged | main | `u01(seed, Source.x, k0..k5)` plus inverse-CDF transforms; think time is log-logistic (K23); ~20M draws/s in Node |
| E2 Event core | merged | main | `createDayRunner(modules)`; `defineModule`; two-number event payloads; kind ranges E6 100s, E7 200s, E5 300s, E8 400s, E9 500s; ~2M events/s in the core; K27 |
| E3 Cost model | merged | main | Batch-1 TPOT +5% at 8k, +20% at 32k, +77% at 122,880 (K3 holds); TTFT 38 s at 120k. Tab 3 compute-util bound tightened in §7.3. |
| E4b KV fast path | running | | Cycle cost ~140 ns → ≤ 30 ns, same API (G1) |
| E4 KV blocks | merged | main | Recipe at the top of `src/engine/kv/index.ts`; ~9 µs per request lifecycle; warm-pool clone 0.31 ms / 310 KiB. Free-block order follows vLLM ≥0.26 (0.20.1 differs by ~1 partial block per request; one-line change if parity matters). |
| E5 Scheduler | merged | main | `replicaModule`; `createReplicaModule({ eventJumping: false })` for E10; `harness.ts`/`workload.ts` for tests. Jumping = per-step over 100 seeds; ~19k sim-s/wall-s per replica (tsx). K32. meterSync topic added so E7 samples exact KV. |
| E6 Load generator | merged | main | `loadModule`, `sessionPlan`; ~4 requests/session; session ids are sparse (candidate indices; extras ≥ 2^31) — never size storage by session count. C2: tab 3's 'long conversations' and tab 2's rate step are lasting 'set' patches today (they carry into later days); decide with the author whether a one-shot workload InjectedEvent is needed. |
| E7 Router | merged | main | Admission counts admitted-not-ended (incl. router overhead); no routable replica → reject. C3: use virtualNodesPerReplica ≥ 128 (64 lets one replica own ~15.6% of the ring). Signal refresh runs all day (~86k events at 1 s). |
| E8 Failure | running | | Started early: only emits replicaState, which E5 and E7 consume |
| E9 Metrics | merged | main | `metricsModule`, `dayRollup(state)`, `inFlightTransitions(...)` for detail replays; slice ~23 KB, clone 47 µs; ~1.4–2 µs per request. Rollup utilization = busy within the shift ÷ shift length. Open: 'active window only' emission (skip night buckets) — needs a small contract (E11/E9 follow-up). |
| E10 Oracle | running | | Includes kvUtilization two-replica seeds (meterSync regression) |
| E11 Assembly and worker | running | | Must follow protocol.ts ordering and detail-chunk rules (U2, U8 handoffs) |
| U1 Tokens and shell | merged | main | Tokens in `@theme static` + TS mirror (drift test); primitives; `AppShell`; decisions in K26. Don't use AnimatePresence `popLayout` (injects `<style>`). |
| U2 Store and engine client | merged | main | `createPlaybackStore({ transport, createResults })`; fake transport and fixture store for UI WPs; stale-revision rule refined in protocol.ts; worker file must be `src/worker/engine.worker.ts` |
| U3 Canvas | merged | main | `<SimCanvas store={store} />` fills the canvas slot; ~0.5 ms main-thread per frame at 1,000 dots. Optional later: `TrackedRequestView.prevReplica`. |
| U4 Charts | merged | main | `<ChartStack store={store} />`; defaults from `store.scenario`; ~30 index queries per render at 8 replicas (X1 measures at 1000×). K33. |
| U5 Timeline | merged | main | `WeekTimeline({ store })`, 72 px; playhead moves per frame without React re-renders; K31. Incident markers other than the lesson moment aren't drawn (tabs 5–6: the lesson moment is the incident). |
| U6 Chrome and sidebar | merged | main | `pnpm e2e` now exercises every tab, modal, play, toggle, drawer, reset. X1 swaps `createAppScenarios`/`createAppStore` and the `SlotPlaceholder`s in App.tsx, and keeps one of the two clocks (toolbar vs timeline). Tooltip fixed (no open on click-focus). Toolbar token 78 px. X3: intro says 'Calibrated on…' while calibration is provisional. |
| U7 High side | todo | | |
| U8 Results index | merged | main | `createResultsStore(replicas)`; whole-week chart redraw ~30 ms for 72 queries; detail memory unbounded by default (~3 MB per 10-min Server B window; `maxDetailChunks` if needed). X1: pass `createResults: createResultsStore`. |
| C1 Runner | todo | | |
| C2 Tabs 1–3 | todo | | |
| C3 Tabs 4–6 | todo | | |
| B1 Harness | merged | main | `uv run harness plan all` prints R0–R8; ~3.9 h wall, ~4.2 GPU-h (±50%). vLLM 0.20.1 in the optional `engine` group. |
| B2 Runs | todo | | Blocked on the author: download the Llama weights, free both GPUs, approve GPU use. R0 smoke: `cd benchmarks && uv sync --group engine && uv run harness preflight && uv run harness run R0 --gpus 0 --gpu-approved` |
| B3 Derivation | todo | | |
| B4 Validation | todo | | |
| I1 Bootstrap | merged | main | OIDC subject uses the immutable prefix (K22); bootstrap also takes `site_domain` to scope Route 53 and ACM |
| I2 Site | merged | main | aws provider 6.66; `headers.json` is the header source for Terraform and I4; outputs `site_bucket_name`, `cloudfront_distribution_id`, `site_url`, `log_bucket_name` |
| I3 Deploy workflow | merged | main | deploy.yml calls ci.yml (workflow_call); build job has no id-token; deploy never cancelled; ci concurrency split per workflow |
| I4 CSP smoke test | merged | main | `scripts/serve-prod.ts` + `e2e/`; optional steps marked IF PRESENT for X1 to harden; negative checks (inline style, blob worker, fetch) all fail as expected |
| I5 First deploy | todo | | Author runs |
| X1–X5 | todo | | |

## Measurements

S1 (spike engine, this host): Server B knee day 7–8 s wall; 2,200–3,900× at peak with a prefix cache; 05:00→10:00 in 3.0–3.7 s ticking. Checkpoint clone 2–6 ms. See `docs/spikes/s1-scale.md`.

## v2 ideas

(Parked scope, per 00-build §10.)
