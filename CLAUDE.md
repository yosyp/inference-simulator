# CLAUDE.md

A browser-only teaching simulator: serving an LLM inside a fixed-capacity enclave. It is a static React SPA with a discrete-event engine in a Web Worker, calibrated from vLLM benchmarks run on this machine's GPUs, and hosted on S3 + CloudFront. It's a personal project meant for self-serve demos, not a critical system, so favor a clear, correct lesson over generality.

## Where things are

- `docs/00-build.md` is the build plan: work packages (WPs), which paths each owns, milestones, tests, and budgets. Start here and find your WP.
- `docs/01`–`06` are the design. Rows numbered K1–K21 in each decision log are kickoff amendments. If the design and your task disagree, ask; don't pick one.
- `docs/build-status.md` tracks what's done and what's in flight. Only the integrator edits it.

## Commands

These exist once WP F1 has landed.

```bash
pnpm install
pnpm dev               # Vite dev server
pnpm verify            # lint + typecheck + tests + build; must pass before handoff
pnpm test [path]       # Vitest, including the 200-seed differential oracle
pnpm test:oracle:long  # 5,000 oracle seeds; run before merging engine timing changes
pnpm e2e               # production build + Playwright smoke test under the production CSP
pnpm sim <tab> [...]   # run a scenario headless and print its lesson summary
pnpm perf              # Server B engine throughput and heap
```

Benchmarks are a separate uv project in `benchmarks/`.

## Things that must stay true

ESLint or the CSP smoke test enforces most of these; don't work around them.

- `src/engine` is pure TypeScript: no DOM, no `window` or `document`, and no imports from UI code or `src/worker`. It runs in a Web Worker.
- Randomness goes only through `src/engine/rng`, keyed by entity (session, turn, attempt), never `Math.random`. Keyed draws keep policy comparisons paired.
- Engine state is plain data (objects, arrays, typed arrays) so `structuredClone` checkpoints work. Class instances or functions in state break restore.
- Days are independent: each starts from a standard morning state. Don't add state that carries from one day to the next.
- No runtime network calls, browser storage, or client-side routing; production CSP has `connect-src 'none'`. Bundle workers as files (`new Worker(new URL(...), { type: 'module' })`), never inline or from `blob:` URLs.
- The canvas draws the state at the playhead as a pure function of simulation time, never tweened on wall-clock time. Charts are React-rendered SVG with d3 math; d3 never mutates DOM that React owns.
- Named exports only. No three.js, no GSAP.

## Working alongside other agents

- One WP per worktree and branch (`wp/<id>-<slug>`). Edit only the paths your WP owns (00-build §5).
- Shared files belong to the integrator: `package.json`, the lockfile, root configs, the contracts (00-build §4), this file, and `docs/`. If one needs to change, say so in your handoff note instead of editing it.
- Hand off rebased on `main` with `pnpm verify` green, plus a short note: what changed, what's left, anything surprising. Agents don't push; the author does.

## This machine

- It is also the benchmark host: 2× A100 PCIe 40GB at 250 W, with Llama 3.1 8B Instruct in the local Hugging Face cache. Other work may be using the GPUs, so ask before starting vLLM or anything else that touches them.
- The author runs anything that needs `sudo`, such as `drop_caches` for benchmark R7.

## Infra and secrets

- Don't run `terraform apply`, AWS write commands, or `gh secret set`; write them out for the author. `terraform fmt` and `terraform validate` are fine.
- Treat the repo as public, even while it's private. Never commit secrets, account IDs, ARNs, hostnames, or usernames, and that includes benchmark manifests.

## Writing

- User-facing copy (sidebar, tooltips, status lines) is plain, short, and exact. Before writing copy for a tab, run its scenario (`pnpm sim`) and describe what it actually shows.
- When editing the docs, match their style: short sentences, tables for decisions, and a decision-log row for anything newly decided.
