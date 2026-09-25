# Benchmark run log (B2)

One row per run directory under `raw/`. Every run used vLLM 0.20.1 and the flags in
`runs/engine.toml`. GPU time is wall-clock time with at least one vLLM instance on a GPU.

**Shared conditions for every run below.** The author approved GPU use. An idle ComfyUI
process held about 425 MiB on each GPU at 0% utilization throughout, so every run used
`--allow-busy-gpus`. NVML reports about 944 MiB used per idle GPU, which includes the
driver reserve. The process was not stopped. Each manifest carries an `operator_notes` block
that records this, plus the highest SM utilization `nvidia-smi pmon` saw for that process
during the run window, sampled about every 20 s.

| Run id | Run | GPU | Status | Wall | Notes |
|---|---|---|---|---|---|
| R0-20260923T192925Z | R0 smoke | 0 | complete | 1.3 min | First start on this host, so the compile cache missed. 9,672 blocks × 16 = 154,752 KV tokens; max_num_seqs 256; max_num_batched_tokens 2,048. |
| R0-20260923T193126Z | R0 | 0, then 1 | complete | 1.4 min | Compile cache hit on both GPUs: 9,929 blocks × 16 = 158,864 KV tokens on each. That is 2.6% more than the smoke run, whose compile cache missed. max_num_seqs 256, max_num_batched_tokens 2,048, chunked prefill and async scheduling on. |
| R1-20260923T193249Z | R1 | 0 | complete | 19.8 min | 20 points, prefix hits 0, no preemptions. The power cap held for 46% of samples at 2k tokens and 93% at 120k, with mean SM clock 850–1,050 MHz. |
| R2-20260923T195236Z | R2 | 0 | complete | 25.0 min | 33 points, prefix hits 0 (the concurrency sweep used `unique`, K24), no preemptions. The power cap held for 50–92% of samples in every point, batch-1 decode included. |
| R3-20260923T201748Z | R3 | 0 | complete, 3 warnings | 66.4 min | All 16 steps ran; the overload stop fired only at 24. The knee is between 16 and 17 req/s: TTFT p50 252 ms at 16, 2.6 s at 17, 45 s at 24. That is inside the 14–19 range the ladder was planned for, so R5's rate stays as defined. 3 of ~36k requests failed client-side (aiohttp `ServerDisconnectedError`). Power cap 93–96% of samples. |
| R4-20260923T212416Z | R4 | 0 | complete | 22.3 min | Preemptions: closed_c48 +34 (TPOT p50 30 ms), open_r025 0 (below the ceiling), open_r050 +239 (TTFT p50 16 s). Power cap 97% of samples. |
| R6-20260923T214636Z | R6 | 0 | complete | 6.0 min | Warm hits = (n − 1) × prefix at every point; cold 0. TTFT p50 at a 32k prefix + 256: warm 278 ms, cold 4,936 ms. With 8 in flight, TTFT p50 is 341 ms with shared 4k prefixes and 1,389 ms with distinct ones. |
| R5-20260923T215247Z | R5 | 0 | complete | 20.9 min | 15 req/s as defined (no override; see R3). 9,000/9,000 completed: a 600 s hold, then about 510 s to drain. 425 preemptions. TTFT p50 232 s, which is queueing. Power cap 98% of samples. |
| R7-20260923T221344Z-process-restart | R7, process restart only | 0 | complete | 4.6 min | One prime start, then 3 timed starts. Trials 1 and 2: weights loaded 17.7–17.9 s, `/health` 200 at 28.9–29.1 s, first token 0.08 s later. Trial 3 stalled 157 s in c10d init after `The hostname of the client socket cannot be retrieved. err=-3` (a transient name-resolution failure, not cold-start work). The median excludes it. Host reboot and replacement host are not run: they need `sudo` (below). |
| R8-20260923T221822Z | R8 | 0, 1, both | complete | 16.9 min | GPU 0 alone, GPU 1 alone, then both. Output throughput with both loaded is within 0.2% of solo on every load, and TPOT p50 within 1.5%. TTFT p50 moves by up to 20%: the closed-loop first wave starts synchronized, so this is not interference. Replicas scale linearly (03 §4). |

**Totals.** The campaign ran 19:29–22:36 UTC on 2026-09-23: 3.1 h wall-clock and about 3.2
GPU-hours of vLLM time. Every run definition was used as written: no sweep point was trimmed,
and R5 needed no rate override. Across 1,114 `pmon` samples, the idle ComfyUI process never
went above 0% SM utilization on either GPU.

## Left for the author: R7 host reboot and replacement host

These two conditions need `sudo` to drop the page cache, so B2 didn't run them.
`calibration.measured.json` carries the provisional `hostReboot` and `replacementHost` values
until they are measured. The app uses `replacementHost` (Theme 3 Q4).

Run the full R7 from a terminal. It repeats process restart, which takes about 2 minutes, then
pauses before each privileged step. The GPUs must be as free as they were for B2; the idle
ComfyUI process is fine.

```bash
cd benchmarks
uv run harness run R7 --gpu-approved --allow-busy-gpus
```

At each pause, run the printed commands in a second terminal, then type `done`. `<ts>` is the
run's timestamp, which the harness prints.

```bash
# before host_reboot-1, -2 and -3 (three times):
sync; echo 3 | sudo tee /proc/sys/vm/drop_caches

# before replacement_host-1:
sync; echo 3 | sudo tee /proc/sys/vm/drop_caches
mv ~/.cache/vllm/torch_compile_cache ~/.cache/vllm/torch_compile_cache.orig-R7-<ts>

# before replacement_host-2 (then -3 with 2 in place of 1):
sync; echo 3 | sudo tee /proc/sys/vm/drop_caches
mv ~/.cache/vllm/torch_compile_cache ~/.cache/vllm/torch_compile_cache.replacement_host-1-R7-<ts>

# after the last start, restore the original compile cache:
mv ~/.cache/vllm/torch_compile_cache ~/.cache/vllm/torch_compile_cache.replacement_host-3-R7-<ts>
mv ~/.cache/vllm/torch_compile_cache.orig-R7-<ts> ~/.cache/vllm/torch_compile_cache
rm -rf ~/.cache/vllm/torch_compile_cache.replacement_host-{1,2,3}-R7-<ts>   # optional
```

Then rerun the derivation and commit the run. `scripts/derive.py` picks the newest complete R7
and replaces the provisional values for every condition that run measured.

```bash
uv run python scripts/derive.py
git add benchmarks/raw/R7-<ts> benchmarks/derived/calibration.measured.json benchmarks/derived/report.md
```

Expect about 20 minutes. Replacement-host starts recompile (about 15 s of torch.compile on the
first R0 start). R0's smoke run also suggests a cold compile leaves about 2.6% less KV pool:
154,752 tokens instead of 158,864. The replacement-host starts will confirm it.
