"""Write the run manifest and post-process files that will be committed.

Everything headed for `raw/<run-id>/` passes through the scrubber, and the manifest writer
refuses to write if anything identifying survives (03 open item 4).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .samplers import sanitize
from .scrub import Scrubber

SCHEMA_VERSION = 1


class ManifestLeak(RuntimeError):
    pass


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def write_manifest(path: Path, manifest: dict, scrubber: Scrubber | None = None) -> dict:
    s = scrubber or Scrubber()
    clean = s.obj(sanitize(manifest))
    text = json.dumps(clean, indent=2, default=str) + "\n"
    leaks = s.leaks(text)
    if leaks:
        raise ManifestLeak(f"manifest still contains: {', '.join(sorted(set(leaks)))}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, text)
    return clean


def postprocess_bench(path: Path, scrubber: Scrubber, drop_generated_texts: bool) -> dict | None:
    """Scrub a `vllm bench serve` result in place and return its summary numbers.

    Random-token prompts produce meaningless completions; dropping `generated_texts` keeps
    the committed files small. Output lengths stay in `output_lens`.
    """
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if drop_generated_texts and "generated_texts" in data:
        data.pop("generated_texts")
        data["harness_note"] = "generated_texts removed by the harness (random prompts); output_lens kept"
    data = scrubber.obj(data)
    _atomic_write(path, json.dumps(data) + "\n")
    return bench_summary(data)


SUMMARY_KEYS = (
    "completed",
    "failed",
    "duration",
    "total_input_tokens",
    "total_output_tokens",
    "request_throughput",
    "output_throughput",
    "total_token_throughput",
    "max_concurrent_requests",
)


def bench_summary(data: dict) -> dict:
    out = {k: data.get(k) for k in SUMMARY_KEYS if k in data}
    for metric in ("ttft", "tpot", "itl", "e2el"):
        for stat in ("mean", "median", "p50", "p90", "p99"):
            key = f"{stat}_{metric}_ms"
            if key in data:
                out[key] = data[key]
    return out


def scrub_file(src: Path, dst: Path, scrubber: Scrubber) -> None:
    """Copy a text file (a server log) with every line scrubbed."""
    with open(src, errors="replace") as fi, open(dst, "w") as fo:
        for line in fi:
            fo.write(scrubber.text(line))
