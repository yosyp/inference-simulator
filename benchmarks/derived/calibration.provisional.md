# Provisional calibration: sources

`calibration.json` has `"status": "provisional"` until benchmarks R0–R8 run (03-benchmarks, K10). B3 writes `calibration.measured.json`; X4 promotes it. Every value below is an estimate.

| Field | Value | Source |
|---|---|---|
| `gpu.peakDenseFp16Flops` | 312 TFLOPS | A100 spec sheet, dense FP16 tensor (02 §2) |
| `gpu.memoryBandwidthBytesPerSecond` | 1,555 GB/s | A100 PCIe 40GB spec sheet (02 §2) |
| `gpu.memoryBytes` | 40 GiB | `nvidia-smi` reports 40,960 MiB |
| `model.*` | 8.03B params, 32 layers, hidden 4096, 8 KV heads × 128 | Llama 3.1 8B config; weights = params × 2 bytes; KV = 32 × 8 × 128 × 2 × 2 bytes (03 §3) |
| `engine.kvPoolTokens` | 140,000 | 03 §3 estimate (~18 GiB ÷ 128 KiB), rounded to a multiple of the block size. R0 replaces it. |
| `engine.blockSize` | 16 | vLLM default |
| `engine.maxNumSeqs` | 256 | vLLM default; R0 records the real value |
| `engine.maxNumBatchedTokens` | 8,192 | Placeholder; the served default depends on vLLM version and usage context. R0 records it. |
| `engine.maxModelLen` | 131,072 | 03 §3 (Theme 3 Q2) |
| `costModel.computeEfficiency` (η_c) | 0.5 | Typical GEMM plus attention efficiency under a 250 W cap; R1 fits it |
| `costModel.bandwidthEfficiency` (η_b) | 0.8 | Typical achieved HBM bandwidth for decode; R2 fits it |
| `costModel.stepOverheadMs` (t_o) | 4 ms | Typical vLLM V1 per-step CPU and launch overhead; R2 fits it |
| `coldStartMs.processRestart` | 12 s weights, 45 s ready | Warm page cache and compile cache; graph capture only |
| `coldStartMs.hostReboot` | 25 s weights, 60 s ready | 16 GB from NVMe with a cold page cache; warm compile cache |
| `coldStartMs.replacementHost` | 25 s weights, 115 s ready | Cold page cache and cold compile cache (torch.compile plus graph capture). The app uses this one (Theme 3 Q4). |
| `prefixCache.*` | null | Informational; R6 measures |
