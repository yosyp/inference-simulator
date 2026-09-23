# Inference Simulator — 03 Benchmarks

Status: scoping complete; kickoff review applied (September 2026).
Related docs: 00-build (track B), 02-simulator (how the results are used), 06-deployment (repo layout).

## 1. Purpose

- Calibrate the three roofline numbers: compute efficiency η_c, bandwidth efficiency η_b, and per-step overhead t_o.
- Measure the KV pool size and engine limits the simulator uses as constants.
- Measure cold-start durations for replica recovery.
- Validate that the simulator reproduces the saturation knee.
- Commit raw data so anyone can check the calibration.

## 2. System under test

| Component | Configuration | Relevance |
|---|---|---|
| CPUs | 2 × Intel Xeon Platinum 8380, 40 cores each (80 cores / 160 threads), 2.30 GHz base, 3.40 GHz max, AVX-512 and VNNI | Tokenization, scheduling, host transfers |
| System RAM | 1 TiB (16 × 64 GiB DDR4 ECC RDIMM, 3,200 MT/s, 8 DIMMs per socket) | Page cache for weights |
| GPUs | 2 × NVIDIA A100 PCIe 40GB, compute capability 8.0, ECC on, MIG off | One replica each |
| GPU interconnect | No NVLink; PCIe 4.0 ×16 each; topology SYS (crosses the socket interconnect) | No effect at TP=1 |
| NUMA | 2 nodes, one GPU per node | Pin each replica NUMA-local |
| GPU power | 250 W per GPU; power limiting observed, no thermal slowdown | Absorbed into η_c and η_b |
| Storage | 3.84 TB Intel NVMe (root, LVM/ext4); 2 TB Samsung 990 PRO NVMe at /data | Weight loading, cold start |
| Network | 2 × Intel X550 10GbE; active port negotiates 100 Mb/s | Run the load generator locally |
| Software | Ubuntu 24.04.2 LTS, kernel 6.8.0-134, NVIDIA driver 580.159.04, vLLM 0.20.1, PyTorch 2.11.0, CUDA runtime 13.0 | Record in every run manifest |

## 3. Model and engine

- **Model:** Llama 3.1 8B Instruct, FP16. The Instruct variant fits the chat workload; KV and compute costs are identical to the base model.
- **Engine:** vLLM, TP=1, one instance per GPU, prefix caching on, chunked prefill on.
- **Context:** max_model_len 131,072 (Theme 3 Q2). This allows one request to consume most of the KV pool, which is itself a lesson.
- **Memory:** default gpu_memory_utilization (0.9).

KV arithmetic:

- Weights: 8.03B params × 2 bytes ≈ 16 GB.
- KV per token: 32 layers × 8 KV heads × 128 head dim × 2 (K and V) × 2 bytes = 128 KiB.
- KV pool: about 18 GiB remains after weights and activations, on the order of 140k tokens per GPU. That is about 17 concurrent 8k-token sessions, or about 4 at 32k. Record the exact value vLLM reports at startup.

Why this model:

- It fits on one A100 40GB with room for KV, so 1 GPU = 1 replica holds throughout and tensor parallelism stays out of v1.
- The KV ceiling is reachable with realistic workloads.
- It uses grouped-query attention, like most current production models.

Limitation: high-side deployments often run 70B-class models, which need tensor parallelism. Shapes transfer (the knee, the memory ceiling, routing effects), but absolute numbers do not. A larger model on the same GPU hits the memory ceiling sooner.

## 4. Hardware presets and extrapolation

Principle: benchmarks measure one replica. The presets change only the replica count and keep everything that sets per-replica behavior identical: GPU SKU and power cap, TP=1, one engine per GPU, NUMA-local placement, ×16 PCIe per GPU, and the same CPU family.

| | Current system | Server A | Server B |
|---|---|---|---|
| Real chassis class | — | 2U, Dell PowerEdge R750xa class (dual 3rd Gen Xeon, up to 4 double-width PCIe GPUs) | 4U, Supermicro SYS-420GP-TNR class (dual 3rd Gen Xeon, up to 10 double-width GPUs, PCIe 4.0 switches, dual-root) |
| CPUs | 2 × Xeon Platinum 8380 | Same | Same |
| GPUs | 2 × A100 PCIe 40GB, 250 W | 4 × same | 8 × same |
| GPUs per NUMA node | 1 | 2 | 4 |
| GPU attach | CPU-direct ×16 | CPU-direct ×16 | ×16 per GPU behind PCIe switches (shared uplinks) |
| CPU cores per GPU | 40 | 20 | 10 |
| System RAM | 1 TiB (512 GiB/GPU) | 1 TiB (256 GiB/GPU) | 2 TiB (256 GiB/GPU) |
| KV pool (estimate) | 2 × ~140k tokens | 4 × ~140k | 8 × ~140k |
| GPU power | 500 W | 1,000 W | 2,000 W (chassis PSUs: 4 × 2,000 W redundant) |
| Capacity lost per replica failure | 50% | 25% | 12.5% |

**Where extrapolation holds:** per-replica TTFT vs. prompt length, TPOT vs. batch size, KV pool size, onset of preemption, and cold start of one replica rejoining.

**Caveats:**

- **Simultaneous cold starts** share storage and, on Server B, PCIe switch uplinks. Only single-replica rejoin matches the benchmark.
- **PCIe switches** affect weight loading only; steady-state decode at TP=1 barely touches PCIe.
- **Other GPU variants** (A100 SXM at 400 W, 80GB cards) would change per-GPU numbers.
- **Router and network overhead** are not measured; the simulator adds a fixed constant.
- **Weight transfer to a replacement host** is excluded: weights are assumed pre-staged on local disk. Pulling 16 GB across the enclave network would add about 15 s at 10GbE or about 2 min at 1GbE.

## 5. Harness

- **Load:** `vllm bench serve`.
  - Datasets: random with fixed input and output lengths (EOS ignored), random with a fixed shared prefix, and prefix_repetition.
  - Arrivals: Poisson or gamma request rates, or a max-concurrency cap; linear or exponential ramp-up.
  - Output: `--save-result --save-detailed` for per-request JSON.
- **Wrapper script:**
  - Starts and stops vLLM and timestamps startup phases from log lines.
  - Scrapes `/metrics` every second.
  - Samples NVML every second: power, SM and memory clocks, utilization.gpu, memory used, and clock-event reasons.
  - Writes a run manifest.
- **Practices:**
  - Pin each vLLM instance to its GPU's NUMA node (CPU and memory binding).
  - Run the load generator on the same host, so the 100 Mb/s link stays out of the measurements.
  - Log power and clocks so power-limited intervals are visible.
  - Keep prefix caching out of calibration. `random` prompts are unique, so `vllm:prefix_cache_hits` should stay at 0 during R1 and R2; the wrapper checks this and flags the run if it does not.

**Execution (K10).** Agents run the harness on the benchmark host, which is the machine this repo is developed on. Before any run, the agent confirms with the author that both GPUs are free. The author runs privileged steps personally: `drop_caches` for R7. Model weights are gated. They come from the local Hugging Face cache or a token the author provides, and the token is never committed. Until the runs complete, the app builds against a provisional `calibration.json` with `"status": "provisional"`, built from spec-sheet estimates. The app's footnote says the numbers are provisional.

Example skeletons (all values are placeholders):

```bash
CUDA_VISIBLE_DEVICES=0 numactl --cpunodebind=0 --membind=0 \
  vllm serve meta-llama/Llama-3.1-8B-Instruct --dtype float16 \
  --tensor-parallel-size 1 --max-model-len 131072 --enable-prefix-caching --port 8001

vllm bench serve --model meta-llama/Llama-3.1-8B-Instruct --port 8001 \
  --dataset-name random --random-input-len 2048 --random-output-len 256 --ignore-eos \
  --request-rate 4 --num-prompts 500 \
  --percentile-metrics ttft,tpot,itl,e2el --metric-percentiles 50,90,99 \
  --save-result --save-detailed --result-dir benchmarks/raw/<run-id>
```

## 6. Run plan

| Run | Purpose | Method | Feeds |
|---|---|---|---|
| R0 Startup | KV pool size, engine limits | Record reported KV cache size (tokens), max concurrency, block size, max_num_seqs, max_num_batched_tokens | Constants |
| R1 Prefill calibration | η_c | Batch-1 TTFT vs. prompt length, synthetic fixed lengths from 128 up to ~120k tokens | Cost model |
| R2 Decode calibration | η_b, t_o | Batch-1 TPOT at short context; TPOT vs. concurrency; TPOT vs. context length at fixed concurrency | Cost model |
| R3 Knee validation | Check simulated knee | Open-loop stepped request rates with sampled (lognormal) lengths, KV below ceiling, each step held to steady state | Validation (internal) |
| R4 KV exhaustion | Preemption behavior | Long outputs at a rate that fills the pool; capture preemptions, KV %, waiting | Validation (internal) |
| R5 Sustained overload | Steady-state thrash | Overload held for several minutes; waiting-queue growth, preemption rate | Validation (internal) |
| R6 Prefix cache | Warm vs. cold TTFT | prefix_repetition (cached prefix plus new suffix) vs. unique prefixes. In KV terms, a follow-up turn is a cached prefix plus a new suffix. | Cache model check |
| R7 Cold start | Recovery durations | Three conditions: process restart (caches warm); host reboot (drop page cache); replacement host (drop page cache and move the vLLM compile cache aside). Phases: weights loaded, engine ready, first request. | Recovery constants (replacement host) |
| R8 Independence | Validate extrapolation | Both GPUs at full load together vs. each solo | Server A/B validity |

Replacement-host emulation: `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`, then move vLLM's compile cache directory (by default under `~/.cache/vllm`) aside before start. Graph capture reruns on every start regardless.

## 7. Metrics captured

| Source | Metrics |
|---|---|
| bench serve (per request) | Prompt and output tokens, TTFT, TPOT, ITL, E2E, success or error |
| bench serve (summary) | Throughput and latency percentiles (50/90/99) |
| vLLM `/metrics` (1 s) | `vllm:kv_cache_usage_perc`, `vllm:num_preemptions`, `vllm:prefix_cache_hits`, `vllm:prefix_cache_queries`, `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:iteration_tokens_total`, `vllm:e2e_request_latency_seconds` (counters may appear with a `_total` suffix) |
| NVML (1 s) | utilization.gpu, power draw, SM and memory clocks, memory used, clock-event reasons |
| Wrapper | Startup phase timestamps, run manifest |

## 8. Output format

Raw results and scrapes are committed (Theme 3 Q6). A script derives a small calibration file that the app imports at build time.

```
benchmarks/
  scripts/                 # wrapper, derivation script
  raw/<run-id>/
    manifest.json          # versions, hardware, engine args, run type
    bench-<point>.json     # vllm bench serve --save-detailed output, one file per sweep point (K25)
    metrics.jsonl          # 1 s /metrics scrapes
    nvml.jsonl             # 1 s NVML samples
  derived/calibration.json # consumed by the app
```

`calibration.json` shape (values are placeholders until the runs complete):

```json
{
  "schemaVersion": 1,
  "status": "provisional",
  "source": { "runIds": [], "vllm": "0.20.1", "gpu": "A100-PCIe-40GB", "powerLimitW": 250 },
  "model": { "name": "Llama-3.1-8B-Instruct", "dtype": "float16", "weightBytes": null, "kvBytesPerToken": 131072 },
  "engine": { "kvPoolTokens": null, "blockSize": null, "maxNumSeqs": null, "maxNumBatchedTokens": null, "maxModelLen": 131072 },
  "costModel": { "computeEfficiency": null, "bandwidthEfficiency": null, "stepOverheadMs": null },
  "coldStartMs": {
    "processRestart": { "weightsLoaded": null, "engineReady": null },
    "hostReboot": { "weightsLoaded": null, "engineReady": null },
    "replacementHost": { "weightsLoaded": null, "engineReady": null }
  },
  "prefixCache": { "warmTtftMs": null, "coldTtftMs": null, "prefixTokens": null }
}
```

## 9. Decision log (Theme 3)

| ID | Question | Options considered | Decision |
|---|---|---|---|
| Q1 | How many calibration factors? | One global factor; compute and bandwidth efficiency plus overhead; prefill table plus roofline decode | η_c, η_b, and t_o (supersedes the single factor from Theme 2 Q2) |
| Q2 | Maximum context length? | Leave 128k; cap at 32k; benchmark 128k and expose the cap | Leave 128k |
| Q3 | Synthetic or realistic lengths? | Synthetic only; realistic only; synthetic for calibration plus a realistic knee validation | Synthetic for calibration plus one open-loop sampled-length knee run |
| Q4 | Which cold state does recovery represent? | Process restart; host reboot; replacement host; measure all and parameterize | Replacement host (all three measured) |
| Q5 | Overload run structure? | One ramp; separate knee and KV runs; both plus sustained overload | Knee run, KV run, and sustained overload |
| Q6 | What data goes in the public repo? | Raw plus derived; derived only; raw bundled in app | Raw results and scrapes committed; app imports derived calibration file |

**Kickoff review (September 2026).**

| ID | Question | Options considered | Decision |
|---|---|---|---|
| K10 | Who runs the benchmarks, and what does the app use meanwhile? | Agents run with author approval; agents write and author runs; defer and ship provisional numbers | Agents run on the benchmark host after the author approves GPU use; the author runs privileged steps; the app uses a provisional calibration file (`"status": "provisional"`) until measured values land |
| K24 | Dataset for R2's concurrency sweep | vLLM `random`; fully random `unique` prompts | `unique` for R2's concurrency sweep. vLLM's `random` prompts are consecutive token-id runs from a random start, so with hundreds of prompts per point about one pair per point collides and hits the prefix cache. R1 and the rest of R2 stay on `random`. |
| K25 | Raw bench output layout | One `bench.json` per run; one file per sweep point | One `bench-<point>.json` per point; the manifest maps each file to its parameters and time window |

## 10. Open items

1. Exact sweep points for R1–R3, and the hold duration per rate step. Proposed in `benchmarks/runs/*.toml` (B1); the author reviews them before B2.
2. Whether to model weight transfer to a replacement host as a network-speed parameter (currently excluded).
3. Fit quality of a single η_c. Attention is about two-thirds of prefill FLOPs at 120k tokens and about a third at 32k, and FlashAttention efficiency differs from GEMM efficiency. The derivation reports residuals across R1's range. If they exceed about 15% at either end, split η_c into GEMM and attention efficiencies (calibration schema v2).
4. Manifests are published. Scrub hostnames, usernames, and tokens before committing raw data.
