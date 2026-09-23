"""Versions and hardware summary for the run manifest.

Everything here is read-only: package metadata (no imports of torch or vLLM, so no CUDA
initialization), /proc, /sys, and NVML. Nothing reads the hostname; the scrubber removes it
anyway.
"""

from __future__ import annotations

import importlib.metadata as md
import os
import platform
import re
import subprocess
from pathlib import Path

from . import PROJECT_ROOT
from .phases import ANSI_RE

PACKAGES = (
    "vllm",
    "torch",
    "nvidia-cuda-runtime",
    "nvidia-cudnn-cu13",
    "nvidia-nccl-cu13",
    "flashinfer-python",
    "triton",
    "transformers",
    "tokenizers",
    "nvidia-ml-py",
)


def package_versions() -> dict[str, str | None]:
    out = {}
    for name in PACKAGES:
        try:
            out[name] = md.version(name)
        except md.PackageNotFoundError:
            out[name] = None
    return out


def os_release() -> str | None:
    try:
        text = Path("/etc/os-release").read_text()
    except OSError:
        return None
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', text, re.MULTILINE)
    return m.group(1) if m else None


def versions(include_nvml: bool = True) -> dict:
    pk = package_versions()
    cuda_rt = pk.get("nvidia-cuda-runtime")
    out = {
        "vllm": pk.get("vllm"),
        "torch": pk.get("torch"),
        "cuda_runtime": ".".join(cuda_rt.split(".")[:2]) if cuda_rt else None,
        "packages": pk,
        "python": platform.python_version(),
        "kernel": platform.release(),
        "os": os_release(),
    }
    if include_nvml:
        try:
            from . import nvml

            out.update(nvml.driver_versions())
        except Exception as e:  # NVML unavailable: record why, don't fail the run
            out["nvml_error"] = type(e).__name__
    return out


def _cpuinfo() -> dict:
    model, phys, cores = None, set(), None
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            k, _, v = line.partition(":")
            k, v = k.strip(), v.strip()
            if k == "model name" and model is None:
                model = v
            elif k == "physical id":
                phys.add(v)
            elif k == "cpu cores" and cores is None:
                cores = int(v)
    except OSError:
        pass
    return {"model": model, "sockets": len(phys) or None, "cores_per_socket": cores, "threads": os.cpu_count()}


def _mem_gib() -> float | None:
    info = meminfo()
    return round(info["MemTotal"] / 2**20, 1) if "MemTotal" in info else None


def meminfo() -> dict[str, int]:
    """/proc/meminfo in KiB. R7 records `Cached` before and after drop_caches as evidence."""
    out = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            out[k.strip()] = int(v.split()[0])
    except (OSError, ValueError, IndexError):
        pass
    return out


def numa_nodes() -> list[dict]:
    nodes = []
    for d in sorted(Path("/sys/devices/system/node").glob("node[0-9]*")):
        try:
            cpus = (d / "cpulist").read_text().strip()
        except OSError:
            cpus = None
        nodes.append({"node": int(d.name[4:]), "cpus": cpus})
    return nodes


def hardware(include_nvml: bool = True) -> dict:
    out = {
        "cpu": _cpuinfo(),
        "memory_gib": _mem_gib(),
        "numa_nodes": numa_nodes(),
    }
    if include_nvml:
        try:
            from . import nvml

            out["gpus"] = nvml.inventory()
        except Exception as e:
            out["gpus_error"] = type(e).__name__
        try:
            topo = subprocess.run(["nvidia-smi", "topo", "-m"], capture_output=True, text=True, timeout=20).stdout
            out["gpu_topology"] = ANSI_RE.sub("", topo).split("\n\nLegend")[0].strip() or None
        except (OSError, subprocess.SubprocessError):
            out["gpu_topology"] = None
    return out


def git_info() -> dict:
    def git(*args: str) -> str | None:
        try:
            r = subprocess.run(["git", *args], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=10)
            return r.stdout.strip() if r.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    status = git("status", "--porcelain", "--", "scripts", "runs", "pyproject.toml", "uv.lock")
    return {"commit": git("rev-parse", "HEAD"), "harness_dirty": bool(status) if status is not None else None}
