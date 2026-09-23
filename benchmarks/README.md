# Benchmarks

The vLLM benchmark harness for the Inference Simulator's calibration (docs/03-benchmarks.md,
work package B1). It starts vLLM 0.20.1 on each A100, drives `vllm bench serve`, samples
`/metrics` and NVML once a second, and writes a scrubbed manifest per run. B2 runs R0–R8 with
it; B3 derives `derived/calibration.json` from the results.

```
benchmarks/
  pyproject.toml, uv.lock   uv project; vLLM 0.20.1 lives in the optional `engine` group
  runs/engine.toml          engine flags shared by every run (03 §3)
  runs/R0.toml … R8.toml    run definitions and sweep points (03 §6, open item 1)
  scripts/harness/          the wrapper: CLI, plan builder, executor, parsers, scrubber
  tests/                    pytest; never touches a GPU
  raw/<run-id>/             results (B2 commits these)
```

## Setup

```bash
cd benchmarks
uv sync                    # harness + tests only (small): enough for dry runs and pytest
uv sync --group engine     # + vLLM 0.20.1, torch 2.11.0 (CUDA 13.0 runtime): ~7.6 GB, for real runs
```

The stack is pinned in `uv.lock`: vLLM 0.20.1, torch 2.11.0 with the PyPI CUDA 13.0 runtime
(driver 580 supports it), flashinfer 0.6.8.post1, Python 3.12. `uv run` never removes the
engine group once it's installed.

**Model weights.** Runs are offline (`HF_HUB_OFFLINE=1`) and read Llama 3.1 8B Instruct from
the local Hugging Face cache. The model is gated, so the author downloads it once with their
own token (never committed). The `original/` folder is a second 16 GB copy vLLM doesn't use.

```bash
uv run --group engine hf download meta-llama/Llama-3.1-8B-Instruct --exclude "original/*"
```

`uv run harness preflight` reports anything missing.

## Dry run

Prints every command a run would execute (vLLM launch, bench invocations, scrapers,
privileged steps) and a time estimate. It starts nothing and touches no GPU.

```bash
uv run harness plan all          # full R0–R8 plan
uv run harness plan R1           # one run (same as: uv run harness run R1 --dry-run)
uv run harness list              # runs, point counts, estimated minutes
uv run harness validate          # check every run file
```

The estimate uses the provisional roofline (η_c 0.5, η_b 0.8, t_o 4 ms), so expect ±50%. It
currently puts R0–R8 at about 4 h wall-clock and 4.2 GPU-hours of use. Keeping both GPUs
free for the whole campaign books about 8 GPU-hours.

## Running (needs the author's approval)

Every real run uses the GPUs, and the protocol is the same each time (00-build Track B, K10):

1. Ask the author to approve GPU use for the named run(s).
2. Check both GPUs are free: `nvidia-smi` and `uv run harness preflight`. Preflight is read-only.
   It checks weights, tools, ports, GPU occupancy through NVML, and the NUMA map.
3. Run with `--gpu-approved`. Without the flag the harness refuses. It also refuses if
   preflight fails. `--allow-busy-gpus` overrides only the GPU-occupancy check.

```bash
uv run harness run R0 --gpus 0 --gpu-approved     # first smoke run: one start, ~3 min
uv run harness run R1 --gpu-approved
```

Useful options: `--gpus 1` moves a single-GPU run to GPU 1. `--set request_rate=13.5` and
`--rate-scale 0.8` shift the R3–R5 rates once the knee is known, without editing run files.
`--run-id-suffix retry` tags a rerun. Every override is recorded in the manifest.
`HARNESS_VLLM_BIN` points at a vLLM in another venv.

### What each run does

Each run starts vLLM with the same flags, pinned to its GPU's NUMA node:
`numactl --cpunodebind=N --membind=N`, GPU 0 on node 0 and GPU 1 on node 1, port 8001 + GPU
index. It waits for `/health` and sends one timed request. From dev-mode `/server_info` it
records the resolved engine config: max_num_seqs, max_num_batched_tokens, block_size,
num_gpu_blocks. Then it runs the points and stops vLLM (SIGINT, then SIGTERM, then SIGKILL).

| Run | GPU | What happens | Est. |
|---|---|---|---|
| R0 Startup | 0, then 1 | Start, first request, record KV cache tokens, max concurrency, block size, batching limits, stop | 4 min |
| R1 Prefill | 0 | Batch-1 TTFT at 20 prompt lengths, 128 → 120,000 tokens, output 1 token | 21 min |
| R2 Decode | 0 | Batch-1 TPOT; TPOT vs concurrency 1 → 256; TPOT vs context at batch 1 (to 120k) and batch 8 (to 12k) | 26 min |
| R3 Knee | 0 | Poisson steps 2 → 24 req/s, lognormal lengths, 180 s each; stops two steps past the knee | ~1 h |
| R4 KV exhaustion | 0 | 1k-in/4k-out requests: 48 concurrent, then Poisson 0.25 and 0.5 req/s for 300 s | 25 min |
| R5 Overload | 0 | Poisson 15 req/s (~1.5× knee) held 600 s, longer lognormal lengths | 20 min |
| R6 Prefix cache | 0 | Warm (shared prefix 1k–32k + 256 suffix) vs cold at matched lengths; prefix_repetition under load | 10 min |
| R7 Cold start | 0 | 3 conditions × 3 starts, timed to weights loaded, engine ready, first token; waits for the author between starts | ~1 h |
| R8 Independence | 0 and 1 | Same three loads on GPU 0 alone, GPU 1 alone, then both at once | 20 min |

Sweep points and their reasons are in the comments at the top of each `runs/R*.toml`.

Before each point, the harness resets the prefix cache (`POST /reset_prefix_cache`) and gives
the point its own `--seed`. vLLM's `random` dataset derives token ids from the seed, so two
points with one seed would share prompt prefixes and hit the cache.

### Prefix-cache check (R1, R2)

Calibration prompts must be unique, so `vllm:prefix_cache_hits` must not grow (03 §5). The
harness reads the counter right before and after every point, and it accepts it with or
without the `_total` suffix. If the counter grew, it flags the run in the manifest
(`prefix_cache_hits_nonzero`, with hit tokens and hit rate) and exits non-zero. To re-check
a finished run from its 1 s scrape:

```bash
uv run harness check raw/R1-<timestamp>Z
```

vLLM's `random` prompts are runs of consecutive token ids from a random start, so two
requests with the same start are identical. With hundreds of prompts per point, a hit is
likely: about n²/256k collisions per point. R2's concurrency sweep therefore uses the
harness's `unique` dataset: fully random tokens at exact lengths, generated on CPU into a
custom JSONL (`python -m harness.datasets`). R3 and R5 use the same generator for their
lognormal lengths.

### Privileged steps (R7)

The harness never runs `sudo`, drops caches, or moves the compile cache. For R7 it prints the
commands, then waits:

```
==============================================================================
AUTHOR ACTION REQUIRED (before replacement_host-1: the author runs these commands ...)
    sync; echo 3 | sudo tee /proc/sys/vm/drop_caches
    mv ~/.cache/vllm/torch_compile_cache ~/.cache/vllm/torch_compile_cache.orig-R7-<ts>
Then confirm with:  touch <run dir>/local/confirm-04-replacement_host-1
==============================================================================
```

The author runs the commands in their own terminal, then confirms: either touch the file
named on screen, or type `done` if the harness runs in an interactive terminal (`abort`
stops the run). The harness then checks what it can:
- the compile cache is gone before a replacement-host start;
- the original is back after the final restore step;
- page-cache size before and after, recorded as evidence. It flags `drop_caches_unverified`
  if the page cache didn't shrink.

The conditions run in this order:
1. process_restart: warm caches, after one untimed prime start.
2. host_reboot: page cache dropped before each start.
3. replacement_host: page cache dropped and the compile cache moved aside before each start.
4. A final step restores the original compile cache.

vLLM's compile cache includes its inductor and Triton caches, so moving `torch_compile_cache`
aside is enough. CUDA graphs are recaptured on every start regardless.

## Outputs

```
raw/<run-id>/                 run-id = R<n>-<UTC yyyymmddThhmmssZ>[-suffix]
  manifest.json               scrubbed: versions, hardware, engine args and resolved config,
                              run type, startup phases, per-point params/summary/counters/power, flags
  bench-<point>.json          vllm bench serve --save-result --save-detailed (generated_texts removed)
  metrics.jsonl               1 s /metrics scrapes: {t, gpu, ok, m: {metric: value | histogram}}
  nvml.jsonl                  1 s NVML samples per GPU: power, energy, SM/mem clocks, util, memory, clock events
  server-gpu<N>-<label>.log   scrubbed vLLM log; each line prefixed with the harness's epoch timestamp
  local/                      git-ignored: raw logs, generated datasets, bench client logs, confirmations
```

03 §8 shows one `bench.json` per run. Sweeps have many points, so each point gets its own
`bench-<point>.json`, and R8 adds phase and GPU (`bench-both-gpu1-mixed_c64.json`). The
manifest's `points` list ties each file to its parameters and time window.

Startup phases are in `servers[].phases_ms_from_start` (from process spawn) and
`servers[].values` (KV cache tokens, weight-load seconds, compile time, and so on). R7 also
gets a `cold_start` table. Log lines are timestamped as the harness reads them, because
vLLM's own timestamps have one-second resolution and no year.

**Scrubbing.** Every committed file passes through `harness.scrub`. It removes home paths,
the username, the hostname, private and host IPs, tokens, GPU UUIDs, and MAC addresses. The
manifest writer refuses to write if anything identifying survives. Manifests carry only
allowlisted environment variables and never GPU serials or UUIDs.

## Tests

```bash
uv run pytest
```

The tests cover the phase-log parser (against realistic vLLM 0.20.1 logs), the Prometheus
parser, scrubbing, run-config validation, the prefix-cache check, and the dry run. A guard in
`tests/conftest.py` makes any import of `pynvml`, `torch`, or `vllm` fail, and dry-run tests
fail if a process is spawned.

## Engine notes

- `VLLM_SERVER_DEV_MODE=1` exposes `/reset_prefix_cache` and `/server_info`. The server listens
  on 127.0.0.1 only.
- Usage telemetry is off (`VLLM_NO_USAGE_STATS`, `DO_NOT_TRACK`).
- `CUDA_DEVICE_ORDER=PCI_BUS_ID`, so CUDA, NVML, and `nvidia-smi` agree on GPU numbering.
- The bench client runs on the same host, pinned to its server's NUMA node, with no visible
  GPU. Requests use greedy sampling (`--temperature 0`).
- max_num_seqs, max_num_batched_tokens, and block size stay at vLLM's defaults so that R0
  measures them. On an A100 40GB these are 256, 2048, and 16.
