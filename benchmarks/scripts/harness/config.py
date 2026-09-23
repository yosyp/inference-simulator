"""Run definitions: load `runs/engine.toml` and `runs/R*.toml`, validate, and expand sweeps.

Unknown keys are errors, so a typo in a run file fails validation instead of silently
running with a default.
"""

from __future__ import annotations

import dataclasses
import math
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import RUNS_DIR

KINDS = ("startup", "sweep", "cold_start", "independence")
# random: vLLM's synthetic prompts, runs of consecutive token ids from a random start.
# unique: fully random tokens, exact lengths, written to a custom JSONL by harness.datasets.
#   Two `random` requests that draw the same start (1 in ~128k) are identical and hit the
#   prefix cache, which matters once a zero-hit point has hundreds of prompts.
DATASETS = ("random", "unique", "prefix_repetition", "lognormal")
GENERATED_DATASETS = ("unique", "lognormal")
PRIVILEGED_STEPS = ("drop_caches", "compile_cache_aside")
KNOWN_GPUS = (0, 1)
RUN_ID_RE = re.compile(r"^R[0-9]$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")
# R1 and R2 calibrate the cost model; prefix-cache hits would contaminate them (03 §5).
MUST_CHECK_PREFIX_CACHE = ("R1", "R2")


class ConfigError(ValueError):
    pass


class _Table:
    """Reads keys from a TOML table and remembers which were consumed."""

    def __init__(self, data: dict, where: str):
        if not isinstance(data, dict):
            raise ConfigError(f"{where}: expected a table")
        self.data = data
        self.where = where
        self.used: set[str] = set()

    def get(self, key: str, types: type | tuple[type, ...], default: Any = ..., *, required: bool = False):
        self.used.add(key)
        if key not in self.data:
            if required or default is ...:
                raise ConfigError(f"{self.where}: missing required key '{key}'")
            return default
        value = self.data[key]
        if isinstance(value, bool) and bool not in _as_tuple(types):
            raise ConfigError(f"{self.where}.{key}: expected {_names(types)}, got bool")
        if not isinstance(value, types):
            raise ConfigError(f"{self.where}.{key}: expected {_names(types)}, got {type(value).__name__}")
        return value

    def done(self) -> None:
        extra = sorted(set(self.data) - self.used)
        if extra:
            raise ConfigError(f"{self.where}: unknown key(s) {', '.join(extra)}")


def _as_tuple(t):
    return t if isinstance(t, tuple) else (t,)


def _names(t) -> str:
    return " or ".join(x.__name__ for x in _as_tuple(t))


# --------------------------------------------------------------------------- engine


@dataclass(frozen=True)
class BenchDefaults:
    backend: str = "vllm"
    temperature: float = 0.0
    percentile_metrics: str = "ttft,tpot,itl,e2el"
    metric_percentiles: str = "50,90,99"
    drop_generated_texts: bool = True
    pin_client_numa: bool = True


@dataclass(frozen=True)
class EngineConfig:
    model: str
    dtype: str
    tensor_parallel_size: int
    max_model_len: int
    enable_prefix_caching: bool
    enable_chunked_prefill: bool
    gpu_memory_utilization: float
    host: str
    base_port: int
    seed: int
    kv_pool_estimate_tokens: int
    extra_args: tuple[str, ...]
    env: dict[str, str]
    numa: dict[int, int]
    ready_timeout_s: float
    stop_timeout_s: float
    bench: BenchDefaults

    def port(self, gpu: int) -> int:
        return self.base_port + gpu

    def args_dict(self) -> dict:
        return {
            "model": self.model,
            "dtype": self.dtype,
            "tensor_parallel_size": self.tensor_parallel_size,
            "max_model_len": self.max_model_len,
            "enable_prefix_caching": self.enable_prefix_caching,
            "enable_chunked_prefill": self.enable_chunked_prefill,
            "gpu_memory_utilization": self.gpu_memory_utilization,
            "host": self.host,
            "seed": self.seed,
            "extra_args": list(self.extra_args),
        }


def load_engine(path: Path | None = None) -> EngineConfig:
    path = path or RUNS_DIR / "engine.toml"
    with open(path, "rb") as f:
        t = _Table(tomllib.load(f), path.name)
    env_t = _Table(t.get("env", dict, {}), f"{path.name}[env]")
    env = {}
    for k in env_t.data:
        env[k] = str(env_t.get(k, (str, int)))
    env_t.done()
    numa_t = _Table(t.get("numa", dict, {}), f"{path.name}[numa]")
    numa = {}
    for k in numa_t.data:
        m = re.fullmatch(r"gpu(\d+)", k)
        if not m:
            raise ConfigError(f"{path.name}[numa]: keys must look like gpu0, got '{k}'")
        numa[int(m.group(1))] = numa_t.get(k, int)
    numa_t.done()
    to_t = _Table(t.get("timeouts", dict, {}), f"{path.name}[timeouts]")
    ready_s = float(to_t.get("ready_s", (int, float), 900))
    stop_s = float(to_t.get("stop_s", (int, float), 60))
    to_t.done()
    b_t = _Table(t.get("bench", dict, {}), f"{path.name}[bench]")
    bench = BenchDefaults(
        backend=b_t.get("backend", str, "vllm"),
        temperature=float(b_t.get("temperature", (int, float), 0.0)),
        percentile_metrics=b_t.get("percentile_metrics", str, BenchDefaults.percentile_metrics),
        metric_percentiles=b_t.get("metric_percentiles", str, BenchDefaults.metric_percentiles),
        drop_generated_texts=b_t.get("drop_generated_texts", bool, True),
        pin_client_numa=b_t.get("pin_client_numa", bool, True),
    )
    b_t.done()
    eng = EngineConfig(
        model=t.get("model", str, required=True),
        dtype=t.get("dtype", str, required=True),
        tensor_parallel_size=t.get("tensor_parallel_size", int, 1),
        max_model_len=t.get("max_model_len", int, required=True),
        enable_prefix_caching=t.get("enable_prefix_caching", bool, required=True),
        enable_chunked_prefill=t.get("enable_chunked_prefill", bool, required=True),
        gpu_memory_utilization=float(t.get("gpu_memory_utilization", (int, float), 0.9)),
        host=t.get("host", str, "127.0.0.1"),
        base_port=t.get("base_port", int, 8001),
        seed=t.get("seed", int, 0),
        kv_pool_estimate_tokens=t.get("kv_pool_estimate_tokens", int, 140_000),
        extra_args=tuple(t.get("extra_args", list, [])),
        env=env,
        numa=numa,
        ready_timeout_s=ready_s,
        stop_timeout_s=stop_s,
        bench=bench,
    )
    t.done()
    if eng.tensor_parallel_size != 1:
        raise ConfigError("engine: tensor_parallel_size must be 1 (one replica per GPU, 03 §3)")
    if eng.host not in ("127.0.0.1", "localhost"):
        raise ConfigError("engine: host must be loopback; the load generator runs on the same host (03 §5)")
    if not 0 < eng.gpu_memory_utilization <= 1:
        raise ConfigError("engine: gpu_memory_utilization must be in (0, 1]")
    for gpu in KNOWN_GPUS:
        if gpu not in eng.numa:
            raise ConfigError(f"engine: [numa] has no entry for gpu{gpu}")
    return eng


# --------------------------------------------------------------------------- runs


@dataclass(frozen=True)
class Lognormal:
    """Lognormal length distribution: median = exp(mu), sigma of the underlying normal,
    clipped to [min, max]."""

    input_median: int
    input_sigma: float
    input_min: int
    input_max: int
    output_median: int
    output_sigma: float
    output_min: int
    output_max: int

    @staticmethod
    def clipped_mean(median: float, sigma: float, lo: float, hi: float) -> float:
        # Mean of the unclipped distribution, clamped; good enough for time estimates.
        return min(max(median * math.exp(sigma * sigma / 2), lo), hi)

    def mean_input(self) -> float:
        return self.clipped_mean(self.input_median, self.input_sigma, self.input_min, self.input_max)

    def mean_output(self) -> float:
        return self.clipped_mean(self.output_median, self.output_sigma, self.output_min, self.output_max)


@dataclass(frozen=True)
class PrefixRepetition:
    prefix_len: int
    suffix_len: int
    num_prefixes: int


@dataclass(frozen=True)
class Point:
    id: str
    sweep: str
    index: int
    dataset: str
    num_prompts: int
    seed: int
    input_len: int | None = None
    output_len: int | None = None
    prefix_len: int = 0
    range_ratio: float = 0.0
    request_rate: float = math.inf
    burstiness: float = 1.0
    max_concurrency: int | None = None
    hold_s: float | None = None
    num_warmups: int = 0
    lognormal: Lognormal | None = None
    prefix_repetition: PrefixRepetition | None = None
    reset_prefix_cache: bool = True
    cooldown_s: float = 5.0
    note: str = ""

    def params(self) -> dict:
        d = dataclasses.asdict(self)
        d["request_rate"] = "inf" if math.isinf(self.request_rate) else self.request_rate
        return {k: v for k, v in d.items() if v is not None and v != ""}

    def mean_lengths(self) -> tuple[float, float]:
        """(prompt tokens, output tokens) per request, on average."""
        if self.dataset == "lognormal":
            assert self.lognormal
            return self.lognormal.mean_input(), self.lognormal.mean_output()
        if self.dataset == "prefix_repetition":
            assert self.prefix_repetition and self.output_len
            pr = self.prefix_repetition
            return float(pr.prefix_len + pr.suffix_len), float(self.output_len)
        assert self.input_len and self.output_len
        return float(self.prefix_len + self.input_len), float(self.output_len)

    def max_request_tokens(self) -> int:
        """Largest prompt + output any request in this point can reach."""
        if self.dataset == "lognormal":
            assert self.lognormal
            return self.lognormal.input_max + self.lognormal.output_max
        if self.dataset == "prefix_repetition":
            assert self.prefix_repetition and self.output_len
            pr = self.prefix_repetition
            return pr.prefix_len + pr.suffix_len + self.output_len
        assert self.input_len and self.output_len
        hi_in = math.ceil(self.input_len * (1 + self.range_ratio))
        hi_out = math.ceil(self.output_len * (1 + self.range_ratio))
        return self.prefix_len + hi_in + hi_out

    def describe(self) -> str:
        parts = [self.dataset]
        if self.dataset in ("random", "unique"):
            parts.append(f"in={self.input_len}")
            if self.prefix_len:
                parts.append(f"shared_prefix={self.prefix_len}")
            parts.append(f"out={self.output_len}")
        elif self.dataset == "prefix_repetition":
            pr = self.prefix_repetition
            assert pr
            parts.append(f"prefix={pr.prefix_len} suffix={pr.suffix_len} prefixes={pr.num_prefixes} out={self.output_len}")
        else:
            ln = self.lognormal
            assert ln
            parts.append(
                f"in~LN(median {ln.input_median}, s {ln.input_sigma}) out~LN(median {ln.output_median}, s {ln.output_sigma})"
            )
        if self.max_concurrency:
            parts.append(f"c={self.max_concurrency}")
        parts.append(f"rate={'inf' if math.isinf(self.request_rate) else format(self.request_rate, 'g')}")
        if self.hold_s:
            parts.append(f"hold={self.hold_s:g}s")
        parts.append(f"n={self.num_prompts}")
        return " ".join(parts)


@dataclass(frozen=True)
class OverloadStop:
    """Skip the remaining (higher-rate) points of a sweep once `consecutive` points in a row
    take longer than `duration_ratio` x their nominal arrival window: the queue is growing."""

    duration_ratio: float = 1.5
    consecutive: int = 2


@dataclass(frozen=True)
class Sweep:
    name: str
    note: str
    points: tuple[Point, ...]
    overload_stop: OverloadStop | None = None


@dataclass(frozen=True)
class Warmup:
    num_prompts: int = 8
    input_len: int = 1024
    output_len: int = 64
    max_concurrency: int = 4


@dataclass(frozen=True)
class FirstRequest:
    input_len: int = 128
    output_len: int = 16


@dataclass(frozen=True)
class Condition:
    name: str
    privileged: tuple[str, ...]
    note: str = ""


@dataclass(frozen=True)
class RunConfig:
    id: str
    title: str
    purpose: str
    feeds: str
    kind: str
    gpus: tuple[int, ...]
    source: Path
    prefix_cache_must_be_zero: bool = False
    expect_preemption: bool = False
    warmup: Warmup | None = None
    sweeps: tuple[Sweep, ...] = ()
    first_request: FirstRequest = field(default_factory=FirstRequest)
    trials: int = 1
    conditions: tuple[Condition, ...] = ()
    phases: tuple[tuple[int, ...], ...] = ()
    overrides: dict = field(default_factory=dict)

    def points(self) -> list[Point]:
        return [p for s in self.sweeps for p in s.points]


_POINT_KEYS_SIMPLE: dict[str, tuple] = {
    "dataset": (str,),
    "input_len": (int,),
    "output_len": (int,),
    "prefix_len": (int,),
    "range_ratio": (int, float),
    "num_prompts": (int,),
    "hold_s": (int, float),
    "request_rate": (int, float, str),
    "burstiness": (int, float),
    "max_concurrency": (int,),
    "num_warmups": (int,),
    "seed": (int,),
    "reset_prefix_cache": (bool,),
    "cooldown_s": (int, float),
    "note": (str,),
    "id": (str,),
}
_POINT_KEYS_TABLE = ("lognormal", "prefix_repetition")


def _merge(*tables: dict) -> dict:
    out: dict = {}
    for t in tables:
        for k, v in t.items():
            if k in _POINT_KEYS_TABLE and isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = {**out[k], **v}
            else:
                out[k] = v
    return out


def _parse_rate(v: Any, where: str) -> float:
    if isinstance(v, str):
        if v.lower() in ("inf", "infinity"):
            return math.inf
        raise ConfigError(f"{where}.request_rate: use a number or \"inf\", got '{v}'")
    if v <= 0:
        raise ConfigError(f"{where}.request_rate: must be > 0")
    return float(v)


def _build_point(raw: dict, *, sweep: str, index: int, seed: int, where: str) -> Point:
    t = _Table(raw, where)
    vals: dict[str, Any] = {}
    for key, types in _POINT_KEYS_SIMPLE.items():
        if key in raw:
            vals[key] = t.get(key, types)
    ln = pr = None
    if "lognormal" in raw:
        lt = _Table(t.get("lognormal", dict), f"{where}.lognormal")
        ln = Lognormal(
            input_median=lt.get("input_median", int, required=True),
            input_sigma=float(lt.get("input_sigma", (int, float), required=True)),
            input_min=lt.get("input_min", int, required=True),
            input_max=lt.get("input_max", int, required=True),
            output_median=lt.get("output_median", int, required=True),
            output_sigma=float(lt.get("output_sigma", (int, float), required=True)),
            output_min=lt.get("output_min", int, required=True),
            output_max=lt.get("output_max", int, required=True),
        )
        lt.done()
    if "prefix_repetition" in raw:
        pt = _Table(t.get("prefix_repetition", dict), f"{where}.prefix_repetition")
        pr = PrefixRepetition(
            prefix_len=pt.get("prefix_len", int, required=True),
            suffix_len=pt.get("suffix_len", int, required=True),
            num_prefixes=pt.get("num_prefixes", int, required=True),
        )
        pt.done()
    t.done()

    dataset = vals.get("dataset")
    if dataset not in DATASETS:
        raise ConfigError(f"{where}.dataset: expected one of {', '.join(DATASETS)}, got {dataset!r}")
    rate = _parse_rate(vals.get("request_rate", "inf"), where)
    hold_s = vals.get("hold_s")
    num_prompts = vals.get("num_prompts")
    if (hold_s is None) == (num_prompts is None):
        raise ConfigError(f"{where}: set exactly one of num_prompts or hold_s")
    if hold_s is not None:
        if math.isinf(rate):
            raise ConfigError(f"{where}: hold_s needs a finite request_rate")
        if hold_s <= 0:
            raise ConfigError(f"{where}.hold_s: must be > 0")
        num_prompts = math.ceil(rate * hold_s)
    point = Point(
        id=vals.get("id") or f"{sweep}-{index:02d}",
        sweep=sweep,
        index=index,
        dataset=dataset,
        num_prompts=int(num_prompts),
        seed=vals.get("seed", seed),
        input_len=vals.get("input_len"),
        output_len=vals.get("output_len"),
        prefix_len=vals.get("prefix_len", 0),
        range_ratio=float(vals.get("range_ratio", 0.0)),
        request_rate=rate,
        burstiness=float(vals.get("burstiness", 1.0)),
        max_concurrency=vals.get("max_concurrency"),
        hold_s=float(hold_s) if hold_s is not None else None,
        num_warmups=vals.get("num_warmups", 0),
        lognormal=ln,
        prefix_repetition=pr,
        reset_prefix_cache=vals.get("reset_prefix_cache", True),
        cooldown_s=float(vals.get("cooldown_s", 5.0)),
        note=vals.get("note", ""),
    )
    _check_point(point, where)
    return point


def _check_point(p: Point, where: str) -> None:
    if not SLUG_RE.match(p.id.replace("-", "_")):
        raise ConfigError(f"{where}: point id '{p.id}' must be lowercase letters, digits, - or _")
    if p.num_prompts < 1:
        raise ConfigError(f"{where}: num_prompts must be >= 1")
    if p.max_concurrency is not None and p.max_concurrency < 1:
        raise ConfigError(f"{where}.max_concurrency: must be >= 1")
    if p.burstiness <= 0:
        raise ConfigError(f"{where}.burstiness: must be > 0")
    if not 0 <= p.range_ratio < 1:
        raise ConfigError(f"{where}.range_ratio: must be in [0, 1)")
    if p.num_warmups < 0 or p.cooldown_s < 0 or p.prefix_len < 0:
        raise ConfigError(f"{where}: num_warmups, cooldown_s and prefix_len must be >= 0")
    if p.dataset in ("random", "unique"):
        if not p.input_len or not p.output_len or p.input_len < 2 or p.output_len < 1:
            raise ConfigError(f"{where}: {p.dataset} dataset needs input_len >= 2 and output_len >= 1")
        if p.lognormal or p.prefix_repetition:
            raise ConfigError(f"{where}: {p.dataset} dataset takes no lognormal/prefix_repetition table")
        if p.dataset == "unique" and (p.prefix_len or p.range_ratio):
            raise ConfigError(f"{where}: unique dataset has fixed lengths and no shared prefix")
    elif p.dataset == "prefix_repetition":
        if not p.prefix_repetition or not p.output_len:
            raise ConfigError(f"{where}: prefix_repetition dataset needs a prefix_repetition table and output_len")
        if p.input_len or p.prefix_len or p.lognormal:
            raise ConfigError(f"{where}: prefix_repetition sets lengths in its own table")
        pr = p.prefix_repetition
        if min(pr.prefix_len, pr.suffix_len, pr.num_prefixes) < 1:
            raise ConfigError(f"{where}.prefix_repetition: values must be >= 1")
        if p.num_prompts < pr.num_prefixes:
            raise ConfigError(f"{where}: num_prompts must be >= prefix_repetition.num_prefixes")
    elif p.dataset == "lognormal":
        ln = p.lognormal
        if not ln:
            raise ConfigError(f"{where}: lognormal dataset needs a lognormal table")
        if p.input_len or p.output_len or p.prefix_len or p.prefix_repetition:
            raise ConfigError(f"{where}: lognormal sets lengths in its own table")
        if not (1 <= ln.input_min <= ln.input_median <= ln.input_max):
            raise ConfigError(f"{where}.lognormal: need input_min <= input_median <= input_max")
        if not (1 <= ln.output_min <= ln.output_median <= ln.output_max):
            raise ConfigError(f"{where}.lognormal: need output_min <= output_median <= output_max")
        if ln.input_sigma <= 0 or ln.output_sigma <= 0:
            raise ConfigError(f"{where}.lognormal: sigmas must be > 0")


def _parse_sweeps(t: _Table, where: str, base_seed: int, run_defaults: dict) -> tuple[Sweep, ...]:
    sweeps = []
    seed = base_seed
    for si, raw in enumerate(t.get("sweeps", list, [])):
        sw = _Table(raw, f"{where}.sweeps[{si}]")
        name = sw.get("name", str, required=True)
        if not SLUG_RE.match(name):
            raise ConfigError(f"{sw.where}.name: '{name}' must be a lowercase slug")
        note = sw.get("note", str, "")
        defaults = sw.get("defaults", dict, {})
        os_raw = sw.get("overload_stop", dict, None)
        overload = None
        if os_raw is not None:
            ot = _Table(os_raw, f"{sw.where}.overload_stop")
            overload = OverloadStop(
                duration_ratio=float(ot.get("duration_ratio", (int, float), 1.5)),
                consecutive=ot.get("consecutive", int, 2),
            )
            ot.done()
        raw_points = sw.get("points", list, required=True)
        sw.done()
        if not raw_points:
            raise ConfigError(f"{sw.where}: points is empty")
        points = []
        for pi, rp in enumerate(raw_points):
            if not isinstance(rp, dict):
                raise ConfigError(f"{sw.where}.points[{pi}]: expected a table")
            seed += 1
            points.append(
                _build_point(
                    _merge(run_defaults, defaults, rp),
                    sweep=name,
                    index=pi,
                    seed=seed,
                    where=f"{where}.{name}[{pi}]",
                )
            )
        sweeps.append(Sweep(name=name, note=note, points=tuple(points), overload_stop=overload))
    return tuple(sweeps)


def load_run(path: Path, engine: EngineConfig) -> RunConfig:
    with open(path, "rb") as f:
        t = _Table(tomllib.load(f), path.name)
    where = path.stem
    run_id = t.get("id", str, required=True)
    if run_id != path.stem or not RUN_ID_RE.match(run_id):
        raise ConfigError(f"{path.name}: id must match the file name (R0..R9), got '{run_id}'")
    kind = t.get("kind", str, required=True)
    if kind not in KINDS:
        raise ConfigError(f"{where}.kind: expected one of {', '.join(KINDS)}")
    gpus = tuple(t.get("gpus", list, required=True))
    base_seed = t.get("seed", int, engine.seed)
    run_defaults = t.get("defaults", dict, {})

    warmup = None
    if "warmup" in t.data:
        wt = _Table(t.get("warmup", dict), f"{where}.warmup")
        warmup = Warmup(
            num_prompts=wt.get("num_prompts", int, 8),
            input_len=wt.get("input_len", int, 1024),
            output_len=wt.get("output_len", int, 64),
            max_concurrency=wt.get("max_concurrency", int, 4),
        )
        wt.done()
    fr = FirstRequest()
    if "first_request" in t.data:
        ft = _Table(t.get("first_request", dict), f"{where}.first_request")
        fr = FirstRequest(input_len=ft.get("input_len", int, 128), output_len=ft.get("output_len", int, 16))
        ft.done()
    conditions = []
    for ci, raw in enumerate(t.get("conditions", list, [])):
        ct = _Table(raw, f"{where}.conditions[{ci}]")
        cond = Condition(
            name=ct.get("name", str, required=True),
            privileged=tuple(ct.get("privileged", list, [])),
            note=ct.get("note", str, ""),
        )
        ct.done()
        conditions.append(cond)
    phases = tuple(tuple(p) for p in t.get("phases", list, []))

    run = RunConfig(
        id=run_id,
        title=t.get("title", str, required=True),
        purpose=t.get("purpose", str, required=True),
        feeds=t.get("feeds", str, ""),
        kind=kind,
        gpus=gpus,
        source=path,
        prefix_cache_must_be_zero=t.get("prefix_cache_must_be_zero", bool, False),
        expect_preemption=t.get("expect_preemption", bool, False),
        warmup=warmup,
        sweeps=_parse_sweeps(t, where, base_seed, run_defaults),
        first_request=fr,
        trials=t.get("trials", int, 1),
        conditions=tuple(conditions),
        phases=phases,
    )
    t.done()
    validate_run(run, engine)
    return run


def validate_run(run: RunConfig, engine: EngineConfig) -> None:
    where = run.id
    if not run.gpus or any(not isinstance(g, int) or g not in KNOWN_GPUS for g in run.gpus):
        raise ConfigError(f"{where}.gpus: expected a non-empty subset of {list(KNOWN_GPUS)}")
    if len(set(run.gpus)) != len(run.gpus):
        raise ConfigError(f"{where}.gpus: duplicates")
    if run.id in MUST_CHECK_PREFIX_CACHE and not run.prefix_cache_must_be_zero:
        raise ConfigError(f"{where}: prefix_cache_must_be_zero must be true for {run.id} (03 §5)")
    if run.first_request.input_len < 2 or run.first_request.output_len < 1:
        raise ConfigError(f"{where}.first_request: input_len >= 2 and output_len >= 1")

    if run.kind in ("sweep", "independence"):
        if not run.sweeps:
            raise ConfigError(f"{where}: a {run.kind} run needs at least one [[sweeps]]")
    elif run.sweeps:
        raise ConfigError(f"{where}: a {run.kind} run takes no [[sweeps]]")
    if run.kind == "sweep" and len(run.gpus) != 1:
        raise ConfigError(f"{where}: a sweep run uses exactly one GPU")
    if run.kind == "cold_start":
        if len(run.gpus) != 1:
            raise ConfigError(f"{where}: a cold_start run uses exactly one GPU")
        if run.trials < 1:
            raise ConfigError(f"{where}.trials: must be >= 1")
        if not run.conditions:
            raise ConfigError(f"{where}: a cold_start run needs [[conditions]]")
        names = [c.name for c in run.conditions]
        if len(set(names)) != len(names):
            raise ConfigError(f"{where}.conditions: duplicate names")
        for c in run.conditions:
            if not SLUG_RE.match(c.name):
                raise ConfigError(f"{where}.conditions: '{c.name}' must be a lowercase slug")
            bad = [s for s in c.privileged if s not in PRIVILEGED_STEPS]
            if bad:
                raise ConfigError(f"{where}.conditions.{c.name}: unknown privileged step(s) {bad}")
    elif run.conditions:
        raise ConfigError(f"{where}: only cold_start runs take [[conditions]]")
    if run.kind == "independence":
        if not run.phases:
            raise ConfigError(f"{where}: an independence run needs phases, e.g. [[0], [1], [0, 1]]")
        for ph in run.phases:
            if not ph or any(g not in run.gpus for g in ph):
                raise ConfigError(f"{where}.phases: {list(ph)} must be a non-empty subset of gpus")
        if not any(len(ph) > 1 for ph in run.phases):
            raise ConfigError(f"{where}.phases: need one phase with all GPUs together")
    elif run.phases:
        raise ConfigError(f"{where}: only independence runs take phases")

    ids, seeds = set(), set()
    for p in run.points():
        pw = f"{where}.{p.id}"
        if p.id in ids:
            raise ConfigError(f"{pw}: duplicate point id")
        ids.add(p.id)
        # Distinct seeds matter: the random dataset derives token offsets from the seed,
        # so two points with the same seed share prompt prefixes and hit the prefix cache.
        if p.seed in seeds:
            raise ConfigError(f"{pw}: duplicate seed {p.seed}")
        seeds.add(p.seed)
        if p.max_request_tokens() > engine.max_model_len:
            raise ConfigError(
                f"{pw}: a request can reach {p.max_request_tokens()} tokens, above max_model_len {engine.max_model_len}"
            )
        if not run.expect_preemption and p.max_concurrency and math.isinf(p.request_rate):
            worst = p.max_concurrency * p.max_request_tokens()
            budget = int(0.9 * engine.kv_pool_estimate_tokens)
            if worst > budget:
                raise ConfigError(
                    f"{pw}: {p.max_concurrency} concurrent requests of up to {p.max_request_tokens()} tokens need "
                    f"{worst} KV tokens, above 90% of the ~{engine.kv_pool_estimate_tokens} pool; this run does not "
                    "expect preemption"
                )
    for sw in run.sweeps:
        if sw.overload_stop and any(math.isinf(p.request_rate) for p in sw.points):
            raise ConfigError(f"{where}.{sw.name}: overload_stop only applies to finite request rates")


def discover(runs_dir: Path | None = None) -> list[Path]:
    runs_dir = runs_dir or RUNS_DIR
    return sorted(p for p in runs_dir.glob("R*.toml") if RUN_ID_RE.match(p.stem))


def load_all(runs_dir: Path | None = None, engine: EngineConfig | None = None) -> tuple[EngineConfig, list[RunConfig]]:
    runs_dir = runs_dir or RUNS_DIR
    engine = engine or load_engine(runs_dir / "engine.toml")
    return engine, [load_run(p, engine) for p in discover(runs_dir)]


def select(runs: list[RunConfig], names: list[str]) -> list[RunConfig]:
    if not names or [n.lower() for n in names] == ["all"]:
        return runs
    by_id = {r.id.upper(): r for r in runs}
    out = []
    for n in names:
        key = n.upper()
        if key not in by_id:
            raise ConfigError(f"unknown run '{n}' (have {', '.join(sorted(by_id))})")
        out.append(by_id[key])
    return out


# --------------------------------------------------------------------------- overrides

OVERRIDABLE = {
    "request_rate": (int, float, str),
    "hold_s": (int, float),
    "num_prompts": (int,),
    "max_concurrency": (int,),
    "burstiness": (int, float),
    "cooldown_s": (int, float),
}


def parse_set(items: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in items:
        if "=" not in item:
            raise ConfigError(f"--set expects KEY=VALUE, got '{item}'")
        k, v = item.split("=", 1)
        k = k.strip()
        if k not in OVERRIDABLE:
            raise ConfigError(f"--set: '{k}' is not overridable (allowed: {', '.join(OVERRIDABLE)})")
        v = v.strip()
        try:
            out[k] = int(v)
        except ValueError:
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


def apply_overrides(
    run: RunConfig,
    engine: EngineConfig,
    *,
    gpus: tuple[int, ...] | None = None,
    sets: dict[str, Any] | None = None,
    rate_scale: float | None = None,
) -> RunConfig:
    """Operator overrides from the CLI, recorded in the manifest. B2 uses these to place
    R3-R5 rates around the measured knee without editing the run files."""
    sets = sets or {}
    if not gpus and not sets and not rate_scale:
        return run
    new_sweeps = []
    for sw in run.sweeps:
        pts = []
        for p in sw.points:
            rate = p.request_rate
            if "request_rate" in sets:
                rate = _parse_rate(sets["request_rate"], f"--set {p.id}")
            if rate_scale and not math.isinf(rate):
                rate = rate * rate_scale
            hold = float(sets["hold_s"]) if "hold_s" in sets else p.hold_s
            num = p.num_prompts
            if "num_prompts" in sets:
                num, hold = int(sets["num_prompts"]), None
            elif hold is not None and not math.isinf(rate):
                num = math.ceil(rate * hold)
            q = dataclasses.replace(
                p,
                request_rate=rate,
                hold_s=hold,
                num_prompts=num,
                max_concurrency=sets.get("max_concurrency", p.max_concurrency),
                burstiness=float(sets.get("burstiness", p.burstiness)),
                cooldown_s=float(sets.get("cooldown_s", p.cooldown_s)),
            )
            _check_point(q, f"{run.id}.{p.id} (after overrides)")
            pts.append(q)
        new_sweeps.append(dataclasses.replace(sw, points=tuple(pts)))
    new_gpus = tuple(gpus) if gpus else run.gpus
    phases = run.phases
    if gpus and run.kind == "independence":
        phases = tuple(tuple(g for g in ph if g in new_gpus) for ph in run.phases)
        phases = tuple(ph for ph in phases if ph)
    overrides = dict(sets)
    if gpus:
        overrides["gpus"] = list(gpus)
    if rate_scale:
        overrides["rate_scale"] = rate_scale
    out = dataclasses.replace(run, gpus=new_gpus, sweeps=tuple(new_sweeps), phases=phases, overrides=overrides)
    validate_run(out, engine)
    return out
