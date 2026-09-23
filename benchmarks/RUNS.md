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
