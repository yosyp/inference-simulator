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
