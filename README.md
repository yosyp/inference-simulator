# inference-simulator

An interactive browser simulator of serving a large language model inside a fixed-capacity enclave: a known number of GPUs, a known analyst population, no autoscaling. See `docs/01-product-and-rationale.md`.

## Develop

Requires Node 22 and pnpm 9.

```bash
pnpm install
pnpm dev       # http://localhost:5173
pnpm verify    # lint, typecheck, tests, build
```

The build plan is `docs/00-build.md`; working conventions are in `CLAUDE.md`.
