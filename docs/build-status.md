# Build status

Only the integrator edits this file (00-build §6). Status: todo · running · review · merged.

| WP | Status | Branch | Notes |
|---|---|---|---|
| F1 Scaffold | merged | main | Vite 8, React 19, TS 6.0 (typescript-eslint doesn't support TS 7 yet), Tailwind 4, Vitest 5, ESLint 10, pnpm 9 |
| F2 Contracts | merged | main | Contracts in §4; provisional calibration; fixtures in `src/fixtures/` |
| S1 Scale spike | running | | |
| E1 Keyed RNG | running | | |
| E2 Event core | running | | |
| E3 Cost model | running | | |
| E4 KV blocks | running | | |
| E5 Scheduler | todo | | |
| E6 Load generator | todo | | |
| E7 Router | todo | | |
| E8 Failure | todo | | |
| E9 Metrics | todo | | Waits for G1 |
| E10 Oracle | todo | | |
| E11 Assembly and worker | todo | | |
| U1 Tokens and shell | running | | |
| U2 Store and engine client | running | | Split: the results index is U8 |
| U3 Canvas | todo | | |
| U4 Charts | todo | | |
| U5 Timeline | todo | | |
| U6 Chrome and sidebar | todo | | |
| U7 High side | todo | | |
| U8 Results index | running | | Split from U2 at kickoff |
| C1 Runner | todo | | |
| C2 Tabs 1–3 | todo | | |
| C3 Tabs 4–6 | todo | | |
| B1 Harness | running | | |
| B2 Runs | todo | | Needs author GPU approval |
| B3 Derivation | todo | | |
| B4 Validation | todo | | |
| I1 Bootstrap | merged | main | OIDC subject uses the immutable prefix (K22); bootstrap also takes `site_domain` to scope Route 53 and ACM |
| I2 Site | merged | main | aws provider 6.66; `headers.json` is the header source for Terraform and I4; outputs `site_bucket_name`, `cloudfront_distribution_id`, `site_url`, `log_bucket_name` |
| I3 Deploy workflow | running | | Makes ci.yml reusable (workflow_call) and adds Terraform and e2e steps |
| I4 CSP smoke test | running | | |
| I5 First deploy | todo | | Author runs |
| X1–X5 | todo | | |

## Measurements

(`pnpm perf` results and budget checks land here.)

## v2 ideas

(Parked scope, per 00-build §10.)
