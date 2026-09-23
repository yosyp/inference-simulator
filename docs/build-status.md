# Build status

Only the integrator edits this file (00-build §6). Status: todo · running · review · merged.

| WP | Status | Branch | Notes |
|---|---|---|---|
| F1 Scaffold | merged | main | Vite 8, React 19, TS 6.0 (typescript-eslint doesn't support TS 7 yet), Tailwind 4, Vitest 5, ESLint 10, pnpm 9 |
| F2 Contracts | merged | main | Contracts in §4; provisional calibration; fixtures in `src/fixtures/` |
| S1 Scale spike | running | | |
| E1 Keyed RNG | merged | main | `u01(seed, Source.x, k0..k5)` plus inverse-CDF transforms; think time is log-logistic (K23); ~20M draws/s in Node |
| E2 Event core | merged | main | `createDayRunner(modules)`; `defineModule`; two-number event payloads; kind ranges E6 100s, E7 200s, E5 300s, E8 400s, E9 500s; ~2M events/s in the core; K27 |
| E3 Cost model | merged | main | Batch-1 TPOT +5% at 8k, +20% at 32k, +77% at 122,880 (K3 holds); TTFT 38 s at 120k. Tab 3 compute-util bound tightened in §7.3. |
| E4 KV blocks | merged | main | Recipe at the top of `src/engine/kv/index.ts`; ~9 µs per request lifecycle; warm-pool clone 0.31 ms / 310 KiB. Free-block order follows vLLM ≥0.26 (0.20.1 differs by ~1 partial block per request; one-line change if parity matters). |
| E5 Scheduler | running | | |
| E6 Load generator | running | | |
| E7 Router | running | | |
| E8 Failure | todo | | |
| E9 Metrics | running | | Parameterized; S1's storage recommendations fold in after G1 |
| E10 Oracle | todo | | |
| E11 Assembly and worker | todo | | |
| U1 Tokens and shell | merged | main | Tokens in `@theme static` + TS mirror (drift test); primitives; `AppShell`; decisions in K26. Don't use AnimatePresence `popLayout` (injects `<style>`). |
| U2 Store and engine client | merged | main | `createPlaybackStore({ transport, createResults })`; fake transport and fixture store for UI WPs; stale-revision rule refined in protocol.ts; worker file must be `src/worker/engine.worker.ts` |
| U3 Canvas | running | | |
| U4 Charts | running | | |
| U5 Timeline | running | | |
| U6 Chrome and sidebar | running | | |
| U7 High side | todo | | |
| U8 Results index | running | | Split from U2 at kickoff |
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

(`pnpm perf` results and budget checks land here.)

## v2 ideas

(Parked scope, per 00-build §10.)
