"""Build the exact commands the harness runs. The dry run prints these same objects."""

from __future__ import annotations

import math
import os
import shlex
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import PROJECT_ROOT
from .config import EngineConfig, Point, RunConfig

# Counters and gauges logged every second (03 §7), plus token counters for throughput.
SCRAPED_METRICS = (
    "vllm:kv_cache_usage_perc",
    "vllm:num_preemptions",
    "vllm:prefix_cache_hits",
    "vllm:prefix_cache_queries",
    "vllm:num_requests_running",
    "vllm:num_requests_waiting",
    "vllm:iteration_tokens_total",
    "vllm:e2e_request_latency_seconds",
    "vllm:prompt_tokens",
    "vllm:generation_tokens",
    "vllm:request_success",
)


@dataclass(frozen=True)
class Command:
    argv: tuple[str, ...]
    env: dict[str, str] = field(default_factory=dict)  # variables the harness sets on top of os.environ

    def render(self) -> str:
        prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in self.env.items())
        body = shlex.join(display_path(a) for a in self.argv)
        return f"{prefix} {body}" if prefix else body

    def full_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env.update(self.env)
        return env


def display_path(arg: str) -> str:
    """Show paths inside the project relative to it, so the plan never prints a home dir."""
    try:
        p = Path(arg)
        if p.is_absolute():
            return str(p.relative_to(PROJECT_ROOT))
    except (ValueError, OSError):
        pass
    return arg


def venv_bin(name: str) -> str:
    """An executable next to the running interpreter (the project venv under `uv run`).
    `HARNESS_VLLM_BIN` / `HARNESS_PYTHON_BIN` point at another install."""
    override = os.environ.get(f"HARNESS_{name.upper()}_BIN")
    if override:
        return override
    cand = Path(sys.executable).parent / name
    return str(cand) if cand.exists() else str(PROJECT_ROOT / ".venv" / "bin" / name)


def numactl(node: int) -> tuple[str, ...]:
    return ("numactl", f"--cpunodebind={node}", f"--membind={node}")


def serve_command(engine: EngineConfig, gpu: int) -> Command:
    e = engine
    argv = [
        *numactl(e.numa[gpu]),
        venv_bin("vllm"),
        "serve",
        e.model,
        "--dtype",
        e.dtype,
        "--tensor-parallel-size",
        str(e.tensor_parallel_size),
        "--max-model-len",
        str(e.max_model_len),
        "--enable-prefix-caching" if e.enable_prefix_caching else "--no-enable-prefix-caching",
        "--enable-chunked-prefill" if e.enable_chunked_prefill else "--no-enable-chunked-prefill",
        "--gpu-memory-utilization",
        f"{e.gpu_memory_utilization:g}",
        "--host",
        e.host,
        "--port",
        str(e.port(gpu)),
        "--seed",
        str(e.seed),
        # One access-log line per request is noise at thousands of requests.
        "--disable-uvicorn-access-log",
        *e.extra_args,
    ]
    env = {"CUDA_VISIBLE_DEVICES": str(gpu), **e.env}
    return Command(tuple(argv), env)


def _fmt_rate(r: float) -> str:
    return "inf" if math.isinf(r) else f"{r:g}"


def bench_command(
    engine: EngineConfig,
    run: RunConfig,
    point: Point,
    *,
    gpu: int,
    run_id: str,
    run_dir: Path,
    result_filename: str,
    dataset_path: Path | None = None,
) -> Command:
    e, b, p = engine, engine.bench, point
    argv: list[str] = []
    if b.pin_client_numa:
        argv += numactl(e.numa[gpu])
    argv += [
        venv_bin("vllm"),
        "bench",
        "serve",
        "--backend",
        b.backend,
        "--model",
        e.model,
        "--host",
        e.host,
        "--port",
        str(e.port(gpu)),
    ]
    if p.dataset == "random":
        argv += [
            "--dataset-name",
            "random",
            "--random-input-len",
            str(p.input_len),
            "--random-output-len",
            str(p.output_len),
            "--random-range-ratio",
            f"{p.range_ratio:g}",
        ]
        if p.prefix_len:
            argv += ["--random-prefix-len", str(p.prefix_len)]
    elif p.dataset == "prefix_repetition":
        pr = p.prefix_repetition
        assert pr is not None
        argv += [
            "--dataset-name",
            "prefix_repetition",
            "--prefix-repetition-prefix-len",
            str(pr.prefix_len),
            "--prefix-repetition-suffix-len",
            str(pr.suffix_len),
            "--prefix-repetition-num-prefixes",
            str(pr.num_prefixes),
            "--prefix-repetition-output-len",
            str(p.output_len),
        ]
    else:  # unique / lognormal: a pre-generated custom JSONL with per-request output_tokens
        assert dataset_path is not None
        argv += [
            "--dataset-name",
            "custom",
            "--dataset-path",
            str(dataset_path),
            "--custom-output-len",
            "-1",
            "--skip-chat-template",
            "--disable-shuffle",
        ]
    argv += [
        "--ignore-eos",
        "--num-prompts",
        str(p.num_prompts),
        "--request-rate",
        _fmt_rate(p.request_rate),
        "--burstiness",
        f"{p.burstiness:g}",
    ]
    if p.max_concurrency:
        argv += ["--max-concurrency", str(p.max_concurrency)]
    if p.num_warmups:
        argv += ["--num-warmups", str(p.num_warmups)]
    argv += [
        "--seed",
        str(p.seed),
        "--temperature",
        f"{b.temperature:g}",
        "--percentile-metrics",
        b.percentile_metrics,
        "--metric-percentiles",
        b.metric_percentiles,
        "--request-id-prefix",
        f"{run.id.lower()}-{p.id}-",
        "--label",
        f"{run.id}-{p.id}",
        "--metadata",
        f"run_id={run_id}",
        f"run_type={run.id}",
        f"point={p.id}",
        f"gpu={gpu}",
        "--disable-tqdm",
        "--save-result",
        "--save-detailed",
        "--result-dir",
        str(run_dir),
        "--result-filename",
        result_filename,
    ]
    # The client never needs a GPU; hiding them guarantees it cannot create a context.
    env = {"CUDA_VISIBLE_DEVICES": "", "HF_HUB_OFFLINE": e.env.get("HF_HUB_OFFLINE", "1"), "NO_COLOR": "1"}
    return Command(tuple(argv), env)


def dataset_command(engine: EngineConfig, point: Point, out_path: Path) -> Command:
    """Generate the custom JSONL for a `unique` or `lognormal` point (CPU only, uses the tokenizer)."""
    argv = [
        venv_bin("python"),
        "-m",
        "harness.datasets",
        "--model",
        engine.model,
        "--num-prompts",
        str(point.num_prompts),
        "--seed",
        str(point.seed),
    ]
    if point.dataset == "unique":
        assert point.input_len and point.output_len
        argv += ["--kind", "fixed", "--input-len", str(point.input_len), "--output-len", str(point.output_len)]
    else:
        ln = point.lognormal
        assert ln is not None
        argv += [
            "--kind",
            "lognormal",
            "--input-median",
            str(ln.input_median),
            "--input-sigma",
            f"{ln.input_sigma:g}",
            "--input-min",
            str(ln.input_min),
            "--input-max",
            str(ln.input_max),
            "--output-median",
            str(ln.output_median),
            "--output-sigma",
            f"{ln.output_sigma:g}",
            "--output-min",
            str(ln.output_min),
            "--output-max",
            str(ln.output_max),
        ]
    argv += ["--out", str(out_path)]
    return Command(tuple(argv), {"CUDA_VISIBLE_DEVICES": "", "HF_HUB_OFFLINE": engine.env.get("HF_HUB_OFFLINE", "1")})


def warmup_point(run: RunConfig, seed: int) -> Point:
    w = run.warmup
    assert w is not None
    return Point(
        id="warmup",
        sweep="warmup",
        index=0,
        dataset="random",
        num_prompts=w.num_prompts,
        seed=seed,
        input_len=w.input_len,
        output_len=w.output_len,
        max_concurrency=w.max_concurrency,
    )
