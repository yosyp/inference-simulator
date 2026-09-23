"""Read-only checks before a real run: weights present, GPUs free, NUMA map, tools, ports.

Nothing here starts vLLM or creates a CUDA context; GPU state comes from NVML.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
from dataclasses import dataclass, field
from pathlib import Path

from .commands import venv_bin
from .config import EngineConfig

# vLLM reserves ~0.9 x 40 GiB; anything above this on an idle GPU means someone else is on it.
BUSY_MIB = 1024


@dataclass
class Result:
    name: str
    ok: bool
    detail: str
    blocking: bool = True
    data: dict = field(default_factory=dict)


def hf_hub_cache() -> Path:
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def check_weights(model: str, cache: Path | None = None) -> Result:
    """The model must be fully in the local HF cache: HF_HUB_OFFLINE=1 at run time."""
    cache = cache or hf_hub_cache()
    repo = cache / ("models--" + model.replace("/", "--"))
    ref = repo / "refs" / "main"
    snaps = sorted((repo / "snapshots").glob("*")) if (repo / "snapshots").exists() else []
    if ref.exists():
        snap = repo / "snapshots" / ref.read_text().strip()
    elif snaps:
        snap = snaps[-1]
    else:
        return Result("weights", False, f"{model} is not in the local Hugging Face cache")
    need = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors.index.json"]
    missing = [f for f in need if not (snap / f).exists()]
    idx = snap / "model.safetensors.index.json"
    if idx.exists():
        shards = sorted(set(json.loads(idx.read_text()).get("weight_map", {}).values()))
        missing += [s for s in shards if not (snap / s).exists()]
    if missing:
        return Result(
            "weights",
            False,
            f"{model} snapshot {snap.name[:12]} is incomplete; missing: {', '.join(missing)}",
            data={"missing": missing},
        )
    return Result("weights", True, f"{model} snapshot {snap.name[:12]} complete")


def check_gpus(gpus: list[int]) -> list[Result]:
    from . import nvml

    out = []
    for g in gpus:
        procs = nvml.processes(g)
        used = nvml.memory_used_mib(g) or 0.0
        ok = not procs and used < BUSY_MIB
        detail = f"GPU {g}: {used:.0f} MiB used, {len(procs)} compute process(es)"
        if procs:
            detail += " (" + ", ".join(f"pid {p['pid']} {p['used_mib']} MiB" for p in procs) + ")"
        out.append(Result(f"gpu{g}_free", ok, detail, data={"used_mib": used, "processes": procs}))
    return out


def check_numa(engine: EngineConfig, gpus: list[int]) -> list[Result]:
    from . import nvml

    inv = {d["index"]: d for d in nvml.inventory()}
    out = []
    for g in gpus:
        actual = inv.get(g, {}).get("numa_node")
        want = engine.numa.get(g)
        ok = actual is None or actual == want
        out.append(Result(f"gpu{g}_numa", ok, f"GPU {g}: config NUMA node {want}, sysfs says {actual}"))
    return out


def check_tools() -> list[Result]:
    vllm = Path(venv_bin("vllm"))
    return [
        Result("numactl", shutil.which("numactl") is not None, "numactl on PATH"),
        Result("vllm", vllm.exists(), "vLLM installed in the project venv (uv sync --group engine)"),
    ]


def check_ports(engine: EngineConfig, gpus: list[int]) -> list[Result]:
    out = []
    for g in gpus:
        port = engine.port(g)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            free = s.connect_ex((engine.host, port)) != 0
        out.append(Result(f"port{port}", free, f"port {port} free for GPU {g}"))
    return out


def run_all(engine: EngineConfig, gpus: list[int], *, with_gpu: bool = True) -> list[Result]:
    results = [check_weights(engine.model), *check_tools(), *check_ports(engine, gpus)]
    if with_gpu:
        try:
            results += check_gpus(gpus) + check_numa(engine, gpus)
        except Exception as e:
            results.append(Result("nvml", False, f"NVML query failed: {type(e).__name__}: {e}"))
    return results


def format_results(results: list[Result]) -> str:
    return "\n".join(f"  [{'ok' if r.ok else 'FAIL' if r.blocking else 'warn'}] {r.detail}" for r in results)
