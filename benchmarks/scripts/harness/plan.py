"""Turn a run definition into an ordered list of steps.

The dry run renders these steps and the executor runs the very same list, so the printed
plan is what executes. Steps are plain data; nothing here touches a GPU.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .commands import Command, bench_command, dataset_command, display_path, serve_command, warmup_point
from .config import GENERATED_DATASETS, EngineConfig, RunConfig

WARMUP_SEED_BASE = 900_000  # far from point seeds, so warmup prompts never prefix a point's prompts


@dataclass
class Step:
    kind: str
    title: str
    gpu: int | None = None
    command: Command | None = None
    data: dict = field(default_factory=dict)


@dataclass
class Plan:
    run: RunConfig
    run_id: str
    run_dir: Path
    steps: list[Step]


def url(engine: EngineConfig, gpu: int, path: str) -> str:
    return f"http://{engine.host}:{engine.port(gpu)}{path}"


def vllm_cache_root(engine: EngineConfig) -> str:
    """Where vLLM keeps its compile cache (VLLM_CACHE_ROOT, else XDG_CACHE_HOME/vllm, else ~/.cache/vllm)."""
    if "VLLM_CACHE_ROOT" in engine.env:
        return _tilde(engine.env["VLLM_CACHE_ROOT"])
    if os.environ.get("VLLM_CACHE_ROOT"):
        return _tilde(os.environ["VLLM_CACHE_ROOT"])
    if os.environ.get("XDG_CACHE_HOME"):
        return _tilde(os.path.join(os.environ["XDG_CACHE_HOME"], "vllm"))
    return "~/.cache/vllm"


def _tilde(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path.startswith(home + "/") else path


class _Builder:
    def __init__(self, engine: EngineConfig, run: RunConfig, run_id: str, run_dir: Path):
        self.e, self.run, self.run_id, self.dir = engine, run, run_id, run_dir
        self.local = run_dir / "local"
        self.steps: list[Step] = []

    def add(self, kind: str, title: str, gpu: int | None = None, command: Command | None = None, **data) -> None:
        self.steps.append(Step(kind, title, gpu, command, data))

    # -- building blocks
    def start_server(self, gpu: int, label: str, *, first_request: bool = True, info: bool = True) -> None:
        cmd = serve_command(self.e, gpu)
        log = self.local / f"server-gpu{gpu}-{label}.log"
        self.add("server_start", f"start vLLM on GPU {gpu} (NUMA node {self.e.numa[gpu]}) [{label}]", gpu, cmd, log=str(log), label=label)
        self.add(
            "server_ready",
            f"wait for GET {url(self.e, gpu, '/health')} = 200 (timeout {self.e.ready_timeout_s:g} s); phases parsed from the log",
            gpu,
            url=url(self.e, gpu, "/health"),
            timeout_s=self.e.ready_timeout_s,
            label=label,
        )
        if first_request:
            fr = self.run.first_request
            self.add(
                "first_request",
                f"first request: POST {url(self.e, gpu, '/v1/completions')} (stream, ~{fr.input_len} prompt tokens, {fr.output_len} output tokens)",
                gpu,
                url=url(self.e, gpu, "/v1/completions"),
                input_len=fr.input_len,
                output_len=fr.output_len,
                label=label,
            )
        if info:
            self.add(
                "server_info",
                f"GET {url(self.e, gpu, '/server_info?config_format=json')}, /v1/models, /metrics (resolved engine config, KV cache info)",
                gpu,
                url=url(self.e, gpu, ""),
                label=label,
            )

    def stop_server(self, gpu: int, label: str) -> None:
        self.add("server_stop", f"stop vLLM on GPU {gpu} (SIGINT, SIGTERM after {self.e.stop_timeout_s:g} s, then SIGKILL) [{label}]", gpu, label=label)

    def scrape(self, gpu: int) -> None:
        self.add(
            "scrape_start",
            f"scrape {url(self.e, gpu, '/metrics')} every 1 s -> {display_path(str(self.dir / 'metrics.jsonl'))}",
            gpu,
            url=url(self.e, gpu, "/metrics"),
            path=str(self.dir / "metrics.jsonl"),
        )

    def reset_cache(self, gpu: int) -> None:
        self.add("reset_prefix_cache", f"POST {url(self.e, gpu, '/reset_prefix_cache')}", gpu, url=url(self.e, gpu, "/reset_prefix_cache"))

    def warmup(self, gpu: int) -> None:
        if not self.run.warmup:
            return
        wp = warmup_point(self.run, WARMUP_SEED_BASE + gpu)
        fname = f"warmup-gpu{gpu}.json"
        cmd = bench_command(self.e, self.run, wp, gpu=gpu, run_id=self.run_id, run_dir=self.local, result_filename=fname)
        self.add("bench", f"warmup ({wp.describe()}), not a measurement point", gpu, cmd, point=wp, result=str(self.local / fname), warmup=True, group="warmup")
        self.reset_cache(gpu)

    def points(self, gpus: tuple[int, ...], tag: str = "") -> None:
        for sw in self.run.sweeps:
            if sw.note:
                self.add("note", f"sweep {sw.name}: {sw.note}")
            for p in sw.points:
                ds_path = None
                if p.dataset in GENERATED_DATASETS:
                    ds_path = self.local / "datasets" / f"{p.id}.jsonl"
                    self.add(
                        "gen_dataset",
                        f"generate {p.num_prompts} {p.dataset} prompts for {p.id} (CPU, tokenizer only)",
                        None,
                        dataset_command(self.e, p, ds_path),
                        path=str(ds_path),
                        point=p,
                    )
                if p.reset_prefix_cache:
                    for g in gpus:
                        self.reset_cache(g)
                benches = []
                for g in gpus:
                    # One bench.json per point (03 §8 has one; sweeps have many). R8 adds phase and GPU.
                    fname = f"bench-{tag}-gpu{g}-{p.id}.json" if tag else f"bench-{p.id}.json"
                    cmd = bench_command(
                        self.e, self.run, p, gpu=g, run_id=self.run_id, run_dir=self.dir, result_filename=fname, dataset_path=ds_path
                    )
                    benches.append({"gpu": g, "command": cmd, "result": str(self.dir / fname)})
                title = f"{p.id}: {p.describe()}" + (f"  [{p.note}]" if p.note else "")
                if len(benches) == 1:
                    b = benches[0]
                    self.add(
                        "bench", title, b["gpu"], b["command"], point=p, result=b["result"], group=sw.name, overload_stop=sw.overload_stop, tag=tag
                    )
                else:
                    self.add("bench_parallel", title + f"  (GPUs {', '.join(map(str, gpus))} at once)", None, None, point=p, benches=benches, group=sw.name, tag=tag)
                if p.cooldown_s:
                    self.add("cooldown", f"idle {p.cooldown_s:g} s", seconds=p.cooldown_s)

    # -- run kinds
    def startup(self) -> None:
        for gpu in self.run.gpus:
            self.start_server(gpu, "startup")
            self.stop_server(gpu, "startup")

    def sweep(self) -> None:
        gpu = self.run.gpus[0]
        self.start_server(gpu, "main")
        self.scrape(gpu)
        self.warmup(gpu)
        self.points((gpu,))
        self.add("scrape_stop", f"stop /metrics scraper for GPU {gpu}", gpu)
        self.stop_server(gpu, "main")

    def cold_start(self) -> None:
        gpu = self.run.gpus[0]
        cache = vllm_cache_root(self.e)
        live = f"{cache}/torch_compile_cache"
        orig = f"{live}.orig-{self.run_id}"
        fresh: list[str] = []
        self.add("note", "prime: one untimed start so the page cache and compile cache are warm for process_restart")
        self.start_server(gpu, "prime", info=False)
        self.stop_server(gpu, "prime")
        moved_before = False
        last_fresh: str | None = None
        for cond in self.run.conditions:
            for trial in range(1, self.run.trials + 1):
                label = f"{cond.name}-{trial}"
                cmds: list[str] = []
                verify: dict = {}
                if "drop_caches" in cond.privileged:
                    cmds.append("sync; echo 3 | sudo tee /proc/sys/vm/drop_caches")
                    verify["drop_caches"] = True
                if "compile_cache_aside" in cond.privileged:
                    if not moved_before:
                        cmds.append(f"mv {live} {orig}")
                        moved_before = True
                    else:
                        # The previous replacement-host trial compiled a fresh cache; set it aside too.
                        cmds.append(f"mv {live} {last_fresh}")
                    last_fresh = f"{live}.{label}-{self.run_id}"
                    fresh.append(last_fresh)
                    verify["path_absent"] = live
                if cmds:
                    self.add(
                        "privileged",
                        f"before {label}: the author runs these commands (the harness never does)",
                        gpu,
                        commands=cmds,
                        verify=verify,
                        label=label,
                    )
                self.start_server(gpu, label, info=False)
                self.stop_server(gpu, label)
        if moved_before:
            self.add(
                "privileged",
                "after R7: restore the original compile cache (the author runs these)",
                gpu,
                commands=[f"mv {live} {last_fresh}", f"mv {orig} {live}", "# optional cleanup: rm -rf " + " ".join(fresh)],
                verify={"path_present": live},
                label="restore",
            )

    def independence(self) -> None:
        for ph in self.run.phases:
            tag = "both" if len(ph) > 1 else f"solo{ph[0]}"
            self.add("note", f"phase {tag}: GPU(s) {', '.join(map(str, ph))} under load" + ("; the other GPU stays idle" if len(ph) == 1 else ""))
            # Sequential starts: two engines compiling at once would race on the same compile cache dir.
            for g in ph:
                self.start_server(g, tag)
                self.scrape(g)
            self.points(ph, tag=tag)
            for g in ph:
                self.add("scrape_stop", f"stop /metrics scraper for GPU {g}", g)
                self.stop_server(g, tag)

    def build(self) -> list[Step]:
        self.add("mkdir", f"create {display_path(str(self.dir))}/ and local/ (local/ is git-ignored: raw logs, datasets)", path=str(self.dir))
        self.add(
            "nvml_start",
            f"sample NVML every 1 s for all GPUs -> {display_path(str(self.dir / 'nvml.jsonl'))} (power, SM/mem clocks, util, memory, clock-event reasons)",
            path=str(self.dir / "nvml.jsonl"),
        )
        getattr(self, self.run.kind)()
        self.add("nvml_stop", "stop NVML sampler")
        if self.run.prefix_cache_must_be_zero:
            self.add("check", "check vllm:prefix_cache_hits did not grow during any point; flag the run if it did (03 §5)", name="prefix_cache_zero")
        if not self.run.expect_preemption and self.run.kind in ("sweep", "independence"):
            self.add("check", "check vllm:num_preemptions did not grow (this run stays below the KV ceiling)", name="no_preemption")
        self.add("manifest", f"write scrubbed {display_path(str(self.dir / 'manifest.json'))} (versions, hardware, engine args, run type, phases, flags)", path=str(self.dir / "manifest.json"))
        return self.steps


def build_plan(engine: EngineConfig, run: RunConfig, run_id: str, run_dir: Path) -> Plan:
    return Plan(run, run_id, run_dir, _Builder(engine, run, run_id, run_dir).build())


def render(plan: Plan, estimate_s: float | None = None) -> str:
    r = plan.run
    lines = []
    head = f"== {r.id} · {r.title}  (kind {r.kind}; GPU {', '.join(map(str, r.gpus))}"
    if estimate_s is not None:
        head += f"; est. {estimate_s / 60:.0f} min"
    head += ")"
    lines.append(head)
    lines.append(f"   purpose: {r.purpose}")
    if r.feeds:
        lines.append(f"   feeds:   {r.feeds}")
    if r.overrides:
        lines.append(f"   overrides: {r.overrides}")
    lines.append(f"   run dir: {display_path(str(plan.run_dir))}")
    n = 0
    for s in plan.steps:
        if s.kind == "note":
            lines.append(f"   -- {s.title}")
            continue
        n += 1
        lines.append(f"   [{n}] {s.title}")
        if s.command is not None:
            lines.append(f"       $ {s.command.render()}")
        if s.kind == "server_start":
            lines.append(f"       log -> {display_path(s.data['log'])}")
        if s.kind == "bench":
            lines.append(f"       -> {display_path(s.data['result'])}")
        if s.kind == "bench_parallel":
            for b in s.data["benches"]:
                lines.append(f"       $ {b['command'].render()}")
                lines.append(f"       -> {display_path(b['result'])}")
        if s.kind == "privileged":
            lines.append("       PRINT these commands, then WAIT for the author to confirm:")
            for c in s.data["commands"]:
                lines.append(f"       !  {c}")
    return "\n".join(lines)
