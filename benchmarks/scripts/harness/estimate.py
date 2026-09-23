"""Rough duration estimates for the dry run, so the author can size a GPU booking.

Uses the provisional roofline from 02 §6 with the F2 provisional numbers (eta_c 0.5,
eta_b 0.8, t_o 4 ms). It ignores queueing past saturation and tokenizer time, so treat the
result as +/- 50%.
"""

from __future__ import annotations

import math

from .config import EngineConfig, Point, RunConfig

PEAK_FLOPS = 312e12
PEAK_BW = 1555e9
ETA_C, ETA_B, T_O = 0.5, 0.8, 0.004
PARAMS = 8.03e9
WEIGHT_BYTES = 16.06e9
KV_BYTES_PER_TOKEN = 131072
LAYERS, D_MODEL = 32, 4096
CHUNK = 2048  # vLLM's max_num_batched_tokens default for the API server on A100 40GB

STARTUP_WARM_S = 120.0
STARTUP_COLD_S = 240.0
AUTHOR_STEP_S = 180.0  # time for the author to run a privileged step
FIRST_REQUEST_S = 2.0


def prefill_s(n: float) -> float:
    flops = 2 * PARAMS * n + 2 * LAYERS * D_MODEL * n * n
    return flops / (ETA_C * PEAK_FLOPS) + math.ceil(n / CHUNK) * T_O


def decode_step_s(batch: float, ctx: float) -> float:
    compute = 2 * PARAMS * batch / (ETA_C * PEAK_FLOPS)
    memory = (WEIGHT_BYTES + batch * ctx * KV_BYTES_PER_TOKEN) / (ETA_B * PEAK_BW)
    return T_O + max(compute, memory)


def point_s(p: Point, kv_pool: int = 140_000, max_num_seqs: int = 256) -> float:
    inp, out = p.mean_lengths()
    n = p.num_prompts + p.num_warmups
    ctx = inp + out / 2
    if math.isinf(p.request_rate):
        c = min(p.max_concurrency or n, n)
        waves = math.ceil(n / c)
        return waves * (c * prefill_s(inp) + out * decode_step_s(c, ctx))
    # Open loop: the running batch grows until throughput matches the arrival rate. Capacity
    # rises with batch (weights are read once per step) up to max_num_seqs or the KV pool.
    pre = prefill_s(inp)
    cap = int(min(max_num_seqs, p.max_concurrency or max_num_seqs, max(1, kv_pool // max(ctx, 1))))

    def service(b: int) -> float:  # GPU seconds per request at batch b
        return pre + out * decode_step_s(b, ctx) / b

    arrival = n / p.request_rate
    for b in range(1, cap + 1):
        if 1.0 / service(b) >= p.request_rate:
            return arrival + pre + out * decode_step_s(b, ctx)
    return max(arrival, n * service(cap)) + pre + out * decode_step_s(cap, ctx)


def _points_s(run: RunConfig, engine: EngineConfig) -> tuple[float, int]:
    """Estimated time of all points, applying each sweep's overload stop like the executor."""
    total, count = 0.0, 0
    for sw in run.sweeps:
        streak = 0
        for p in sw.points:
            t = point_s(p, engine.kv_pool_estimate_tokens)
            total += t + p.cooldown_s
            count += 1
            if sw.overload_stop and not math.isinf(p.request_rate):
                streak = streak + 1 if t > sw.overload_stop.duration_ratio * p.num_prompts / p.request_rate else 0
                if streak >= sw.overload_stop.consecutive:
                    break
    return total, count


def run_s(run: RunConfig, engine: EngineConfig) -> float:
    pts, count = _points_s(run, engine)
    fixed = 5.0 * count  # prefix-cache resets, scrapes, file writes
    if run.kind == "startup":
        return len(run.gpus) * (STARTUP_WARM_S + FIRST_REQUEST_S)
    if run.kind == "sweep":
        warm = point_s(_warm(run)) if run.warmup else 0.0
        return STARTUP_WARM_S + warm + pts + fixed
    if run.kind == "cold_start":
        starts = 1 + len(run.conditions) * run.trials
        cold = sum(run.trials for c in run.conditions if "drop_caches" in c.privileged)
        author = sum(run.trials for c in run.conditions if c.privileged) + 1
        return starts * STARTUP_WARM_S + cold * (STARTUP_COLD_S - STARTUP_WARM_S) + author * AUTHOR_STEP_S
    if run.kind == "independence":
        starts = sum(len(ph) for ph in run.phases)
        return starts * STARTUP_WARM_S + len(run.phases) * (pts + fixed)
    return 0.0


def gpus_reserved(run: RunConfig) -> int:
    """GPUs that must stay free for the whole run. R8's solo phases need the other GPU idle."""
    return len(set(run.gpus)) if run.kind == "independence" else 1


def _warm(run: RunConfig) -> Point:
    w = run.warmup
    assert w
    return Point(id="warmup", sweep="warmup", index=0, dataset="random", num_prompts=w.num_prompts, seed=0,
                 input_len=w.input_len, output_len=w.output_len, max_concurrency=w.max_concurrency)
