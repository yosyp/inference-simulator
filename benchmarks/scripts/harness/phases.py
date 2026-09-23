"""Tolerant parser for vLLM startup log lines.

vLLM's log format is ``[(<Proc> pid=N)] LEVEL MM-DD HH:MM:SS [file.py:line] message``, with
optional ANSI colors. The date has no year and one-second resolution, so the harness stamps
each line itself when it reads it from the server's stdout and passes that time in here.

Patterns match on the message text only and allow for wording drift across vLLM releases
(``took X seconds`` vs ``took X s``, with or without a GiB figure). The first match of each
phase wins. Values the calibration needs (KV cache tokens, max concurrency, and so on) are
extracted along the way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# "(EngineCore_DP0 pid=123) INFO 09-23 05:10:11 [gpu_model_runner.py:4880] "
PREFIX_RE = re.compile(
    r"^\s*(?:\((?P<proc>[^)]*?)\s+pid=(?P<pid>\d+)\)\s*)?"
    r"(?:(?P<level>DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+)?"
    r"(?:(?P<date>\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+)?"
    r"(?:\[(?P<src>[^\]]+)\]\s+)?"
)

_NUM = r"([0-9][0-9,]*(?:\.[0-9]+)?)"


@dataclass(frozen=True)
class PhaseRule:
    phase: str
    pattern: re.Pattern
    # capture-group index -> value name
    values: tuple[tuple[int, str], ...] = ()


def _rule(phase: str, pattern: str, *values: tuple[int, str]) -> PhaseRule:
    return PhaseRule(phase, re.compile(pattern, re.IGNORECASE), tuple(values))


# Ordered roughly as they appear during startup. Several phases have alternative wordings.
RULES: tuple[PhaseRule, ...] = (
    _rule("api_server_start", r"vLLM API server version\s+(\S+)", (1, "vllm_version")),
    _rule("api_server_start", r"non-default args:"),
    _rule("max_model_len", r"Using max model len\s+" + _NUM, (1, "max_model_len")),
    _rule(
        "chunked_prefill_config",
        r"Chunked prefill is enabled with max_num_batched_tokens\s*=\s*" + _NUM,
        (1, "max_num_batched_tokens"),
    ),
    _rule("engine_core_start", r"Initializing a V\d+ LLM engine \(v?([^)\s]+)\)", (1, "engine_vllm_version")),
    _rule("model_load_start", r"Starting to load model\b"),
    _rule("model_load_start", r"Loading model from scratch"),
    _rule("weights_loaded", r"Loading weights took\s+" + _NUM + r"\s*s", (1, "weights_load_s")),
    _rule(
        "model_loaded",
        r"Model loading took\s+" + _NUM + r"\s*GiB(?:\s+memory)?\s+and\s+" + _NUM + r"\s*s",
        (1, "model_load_gib"),
        (2, "model_load_s"),
    ),
    _rule("compile_dynamo_done", r"Dynamo bytecode transform time:\s*" + _NUM + r"\s*s", (1, "dynamo_s")),
    _rule(
        "compile_cache_hit",
        r"Directly load the compiled graph\(s\) for .*? from the cache, took\s+" + _NUM + r"\s*s",
        (1, "compile_cache_load_s"),
    ),
    _rule(
        "compile_graph_done",
        r"Compiling a graph for .*? takes\s+" + _NUM + r"\s*s",
        (1, "compile_graph_s"),
    ),
    _rule("compile_done", r"torch\.compile takes?\s+" + _NUM + r"\s*s in total", (1, "torch_compile_s")),
    _rule("compile_done", r"torch\.compile took\s+" + _NUM + r"\s*s in total", (1, "torch_compile_s")),
    _rule("kv_cache_memory", r"Available KV cache memory:\s*" + _NUM + r"\s*GiB", (1, "kv_cache_gib")),
    _rule("kv_cache_size", r"GPU KV cache size:\s*" + _NUM + r"\s*tokens", (1, "kv_cache_tokens")),
    _rule(
        "max_concurrency",
        r"Maximum concurrency for\s+" + _NUM + r"\s+tokens per request:\s*" + _NUM + r"\s*x",
        (1, "max_concurrency_tokens_per_request"),
        (2, "max_concurrency"),
    ),
    _rule(
        "graph_capture_done",
        r"Graph capturing finished in\s+" + _NUM + r"\s*secs?,\s*took\s+" + _NUM + r"\s*GiB",
        (1, "graph_capture_s"),
        (2, "graph_capture_gib"),
    ),
    _rule(
        "engine_init_done",
        r"init engine \(profile, create kv cache, warmup model\) took\s+" + _NUM + r"\s*s",
        (1, "engine_init_s"),
    ),
    _rule("api_listening", r"Starting vLLM (?:API )?server(?: \d+)? on\s+(\S+)", (1, "listen_address")),
    _rule("api_listening", r"Uvicorn running on\s+(\S+)", (1, "listen_address")),
    _rule("app_startup_complete", r"Application startup complete"),
)

# Phases the harness records itself (not from the log).
HARNESS_PHASES = ("process_start", "health_ok", "first_request_sent", "first_token", "first_request_done", "stop_sent", "exited")

# Key phases for cold-start reporting (03 §6 R7): weights loaded, engine ready, first request.
KEY_PHASES = ("weights_loaded", "model_loaded", "engine_init_done", "app_startup_complete", "health_ok", "first_token")

ERROR_RE = re.compile(r"\b(Traceback \(most recent call last\)|CUDA out of memory|OutOfMemoryError|RuntimeError:|ValueError:)")


def strip_line(raw: str) -> tuple[str, dict]:
    """Remove ANSI codes and the vLLM prefix. Returns (message, prefix fields)."""
    line = ANSI_RE.sub("", raw).rstrip("\r\n")
    m = PREFIX_RE.match(line)
    info = {k: v for k, v in (m.groupdict() if m else {}).items() if v}
    return (line[m.end():] if m else line), info


def _num(text: str) -> float | int:
    text = text.replace(",", "")
    f = float(text)
    return int(f) if f.is_integer() and "." not in text else f


@dataclass
class PhaseTracker:
    """Feed it (timestamp, raw line) pairs; it records the first time each phase appears.

    Timestamps are wall-clock epoch seconds. ``t0`` is the process start, so offsets are
    reported in milliseconds from it.
    """

    t0: float | None = None
    phases: dict[str, float] = field(default_factory=dict)
    values: dict[str, float | int | str] = field(default_factory=dict)
    lines_seen: int = 0
    errors: list[str] = field(default_factory=list)

    def mark(self, phase: str, ts: float) -> None:
        """Record a harness-observed phase (first occurrence wins)."""
        if phase == "process_start" and self.t0 is None:
            self.t0 = ts
        self.phases.setdefault(phase, ts)

    def feed(self, ts: float, raw: str) -> list[str]:
        """Parse one line. Returns the phases first seen on this line."""
        self.lines_seen += 1
        msg, _ = strip_line(raw)
        if not msg:
            return []
        new = []
        for rule in RULES:
            m = rule.pattern.search(msg)
            if not m:
                continue
            if rule.phase not in self.phases:
                self.phases[rule.phase] = ts
                new.append(rule.phase)
            for group, name in rule.values:
                if name not in self.values:
                    raw_v = m.group(group)
                    try:
                        self.values[name] = _num(raw_v)
                    except ValueError:
                        self.values[name] = raw_v
        if ERROR_RE.search(msg) and len(self.errors) < 20:
            self.errors.append(msg[:300])
        return new

    def offsets_ms(self) -> dict[str, float]:
        if self.t0 is None:
            return {}
        return {k: round((v - self.t0) * 1000.0, 1) for k, v in sorted(self.phases.items(), key=lambda kv: kv[1])}

    def summary(self) -> dict:
        return {
            "t0_epoch_s": self.t0,
            "phases_epoch_s": dict(sorted(self.phases.items(), key=lambda kv: kv[1])),
            "phases_ms_from_start": self.offsets_ms(),
            "values": dict(self.values),
            "compile_cache": (
                "hit" if "compile_cache_hit" in self.phases else "miss" if "compile_graph_done" in self.phases else "unknown"
            ),
            "errors": list(self.errors),
        }


def parse_log(lines: list[tuple[float, str]], t0: float | None = None) -> PhaseTracker:
    tr = PhaseTracker()
    if t0 is not None:
        tr.mark("process_start", t0)
    for ts, line in lines:
        tr.feed(ts, line)
    return tr


def parse_stamped_log(text: str) -> PhaseTracker:
    """Parse a harness server log, where each line is ``<epoch seconds> <raw line>``."""
    tr = PhaseTracker()
    for line in text.splitlines():
        head, _, rest = line.partition(" ")
        try:
            ts = float(head)
        except ValueError:
            continue
        if rest.startswith("# harness process_start"):
            tr.mark("process_start", ts)
            continue
        tr.feed(ts, rest)
    return tr
