"""Execute a plan for real: the only module that starts processes on the GPUs.

It walks the same `Step` list the dry run prints. Whatever happens (error, Ctrl-C), servers
and samplers are stopped and a scrubbed manifest is written with the run's status.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import select
import subprocess
import sys
import time
import traceback
from pathlib import Path

from . import PROJECT_ROOT, __version__, hostinfo, manifest, prom
from .checks import (
    HITS,
    PREEMPTIONS,
    QUERIES,
    CounterWindow,
    Flag,
    check_bench_result,
    check_no_preemption,
    check_prefix_cache_zero,
    power_cap_summary,
)
from .commands import SCRAPED_METRICS, display_path
from .config import EngineConfig
from .plan import Plan, Step
from .samplers import JsonlWriter, MetricsScraper, NvmlSampler, fetch_metrics
from .scrub import Scrubber, safe_env
from .server import ServerError, VllmServer, http_json, http_post

COUNTERS = (HITS, QUERIES, PREEMPTIONS)
# Subset of /server_info worth keeping: the engine limits R0 records (03 §6).
RESOLVED_KEYS = {
    "scheduler_config": ("max_num_seqs", "max_num_batched_tokens", "max_model_len", "enable_chunked_prefill", "async_scheduling", "policy"),
    "cache_config": ("block_size", "num_gpu_blocks", "gpu_memory_utilization", "enable_prefix_caching", "cache_dtype", "kv_cache_memory_bytes"),
    "model_config": ("model", "dtype", "max_model_len", "seed", "generation_config"),
    "parallel_config": ("tensor_parallel_size", "numa_bind"),
    "compilation_config": ("mode", "level", "cudagraph_mode", "cudagraph_capture_sizes", "max_cudagraph_capture_size"),
    "attention_config": ("backend",),
}


def utc(ts: float | None = None) -> str:
    return dt.datetime.fromtimestamp(ts if ts is not None else time.time(), dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


class Aborted(RuntimeError):
    pass


class Executor:
    def __init__(self, engine: EngineConfig, plan: Plan, *, out=print, argv: list[str] | None = None):
        self.e, self.plan, self.out = engine, plan, out
        self.argv = argv or sys.argv
        self.dir = plan.run_dir
        self.local = plan.run_dir / "local"
        self.scrubber = Scrubber()
        self.servers: dict[int, VllmServer] = {}
        self.server_records: list[dict] = []
        self.scrapers: dict[int, MetricsScraper] = {}
        self.metrics_writer: JsonlWriter | None = None
        self.nvml_writer: JsonlWriter | None = None
        self.nvml: NvmlSampler | None = None
        self.points: list[dict] = []
        self.windows: list[CounterWindow] = []
        self.flags: list[Flag] = []
        self.engine_info: dict[str, dict] = {}
        self.privileged_log: list[dict] = []
        self.datasets: dict[str, dict] = {}
        self._overloaded: dict[str, int] = {}
        self._skip_groups: set[str] = set()
        self._confirm_n = 0

    # ------------------------------------------------------------------ main loop
    def run(self) -> dict:
        started = time.time()
        status, error = "complete", None
        total = sum(1 for s in self.plan.steps if s.kind != "note")
        n = 0
        try:
            for step in self.plan.steps:
                if step.kind == "note":
                    self.out(f"-- {step.title}")
                    continue
                n += 1
                self.out(f"[{n}/{total}] {step.title}")
                getattr(self, f"_do_{step.kind}")(step)
        except KeyboardInterrupt:
            status, error = "aborted", "interrupted by operator"
        except Aborted as e:
            status, error = "aborted", str(e)
        except Exception as e:  # keep going to cleanup + manifest
            status, error = "failed", f"{type(e).__name__}: {e}"
            self.out(traceback.format_exc())
        finally:
            self._cleanup()
        return self._write_manifest(started, time.time(), status, error)

    # ------------------------------------------------------------------ steps
    def _do_mkdir(self, s: Step) -> None:
        (self.local / "datasets").mkdir(parents=True, exist_ok=True)

    def _do_nvml_start(self, s: Step) -> None:
        from . import nvml

        self.nvml_writer = JsonlWriter(Path(s.data["path"]))
        self.nvml = NvmlSampler(list(range(nvml.device_count())), self.nvml_writer)
        self.nvml.start()

    def _do_nvml_stop(self, s: Step) -> None:
        if self.nvml:
            self.nvml.stop()
            self.nvml = None

    def _do_server_start(self, s: Step) -> None:
        assert s.gpu is not None and s.command is not None
        if s.gpu in self.servers and self.servers[s.gpu].alive():
            raise RuntimeError(f"a server is already running on GPU {s.gpu}")
        srv = VllmServer(s.gpu, s.command, Path(s.data["log"]), s.data["label"], self.e.model)
        srv.start()
        self.servers[s.gpu] = srv

    def _do_server_ready(self, s: Step) -> None:
        srv = self.servers[s.gpu]
        t = srv.wait_ready(s.data["url"], s.data["timeout_s"])
        self.out(f"    ready after {t - srv.tracker.t0:.1f} s")

    def _do_first_request(self, s: Step) -> None:
        fr = self.servers[s.gpu].send_first_request(s.data["url"], s.data["input_len"], s.data["output_len"])
        self.out(f"    first token after {fr['ttft_ms']} ms")

    def _do_server_info(self, s: Step) -> None:
        base = s.data["url"]
        info = http_json(base + "/server_info?config_format=json") or {}
        models = http_json(base + "/v1/models") or {}
        try:
            fams = fetch_metrics(base + "/metrics", timeout=10)
            cache_info = prom.compact(fams, ["vllm:cache_config_info"]).get("vllm:cache_config_info")
        except Exception:
            cache_info = None
        record = {
            "gpu": s.gpu,
            "label": s.data["label"],
            "resolved": _resolved(info.get("vllm_config")),
            "vllm_env": safe_env({k: str(v) for k, v in (info.get("vllm_env") or {}).items()}),
            "system_env": _system_env(info.get("system_env") or {}),
            "models": [{"id": m.get("id"), "max_model_len": m.get("max_model_len")} for m in models.get("data", [])],
            "cache_config_info": cache_info,
        }
        if not info:
            self.flags.append(Flag("server_info_unavailable", "warning", "GET /server_info failed; is VLLM_SERVER_DEV_MODE=1 set?"))
        self.engine_info[f"gpu{s.gpu}-{s.data['label']}"] = record

    def _do_scrape_start(self, s: Step) -> None:
        if self.metrics_writer is None:
            self.metrics_writer = JsonlWriter(Path(s.data["path"]))
        sc = MetricsScraper(s.data["url"], s.gpu, self.metrics_writer, SCRAPED_METRICS)
        sc.start()
        self.scrapers[s.gpu] = sc

    def _do_scrape_stop(self, s: Step) -> None:
        sc = self.scrapers.pop(s.gpu, None)
        if sc:
            sc.stop()

    def _do_reset_prefix_cache(self, s: Step) -> None:
        code = http_post(s.data["url"])
        if code != 200:
            raise RuntimeError(f"POST {s.data['url']} returned {code}; the harness needs VLLM_SERVER_DEV_MODE=1")

    def _do_gen_dataset(self, s: Step) -> None:
        assert s.command
        r = subprocess.run(list(s.command.argv), env=s.command.full_env(), capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"dataset generation failed:\n{r.stderr[-2000:]}")
        try:
            self.datasets[s.data["point"].id] = json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            self.datasets[s.data["point"].id] = {}

    def _do_cooldown(self, s: Step) -> None:
        time.sleep(s.data["seconds"])

    def _do_bench(self, s: Step) -> None:
        self._bench([{"gpu": s.gpu, "command": s.command, "result": s.data["result"]}], s)

    def _do_bench_parallel(self, s: Step) -> None:
        self._bench(s.data["benches"], s)

    def _bench(self, benches: list[dict], s: Step) -> None:
        p = s.data["point"]
        group = s.data.get("group", "")
        if group in self._skip_groups:
            self.out(f"    skipped: sweep {group} passed the overload stop")
            self.points.append({"id": p.id, "sweep": p.sweep, "skipped": True, "reason": "overload_stop", "params": p.params()})
            return
        for b in benches:
            srv = self.servers.get(b["gpu"])
            if srv is None or not srv.alive():
                raise ServerError(f"vLLM on GPU {b['gpu']} is not running before {p.id}:\n" + "\n".join(list(srv.tail)[-25:] if srv else []))
        before = {b["gpu"]: self._counters(b["gpu"]) for b in benches}
        t0 = time.time()
        procs = []
        for b in benches:
            log = self.local / (Path(b["result"]).stem + ".log")
            fh = open(log, "w")
            procs.append((b, subprocess.Popen(list(b["command"].argv), env=b["command"].full_env(), stdout=fh, stderr=subprocess.STDOUT), fh))
        for _, proc, fh in procs:
            proc.wait()
            fh.close()
        t1 = time.time()
        for b, proc, _ in procs:
            g = b["gpu"]
            after = self._counters(g)
            summary = manifest.postprocess_bench(Path(b["result"]), self.scrubber, self.e.bench.drop_generated_texts)
            if s.data.get("warmup"):
                if proc.returncode != 0:
                    raise RuntimeError(f"warmup bench failed on GPU {g} (exit {proc.returncode}); see local/")
                continue
            w = CounterWindow(p.id, g, before[g], after)
            self.windows.append(w)
            self.flags += check_bench_result(summary, self.plan.run.id, p.id, p.num_prompts)
            rec = {
                "id": p.id,
                "sweep": p.sweep,
                "tag": s.data.get("tag") or None,
                "gpu": g,
                "params": p.params(),
                "command": b["command"].render(),
                "bench_file": Path(b["result"]).name,
                "exit_code": proc.returncode,
                "started_epoch_s": round(t0, 3),
                "ended_epoch_s": round(t1, 3),
                "started_at": utc(t0),
                "duration_s": round(t1 - t0, 2),
                "summary": summary,
                "counters": {name: w.delta(name) for name in COUNTERS},
            }
            if p.id in self.datasets:
                rec["dataset"] = self.datasets[p.id]
            self.points.append(rec)
            if summary:
                self.out(
                    f"    gpu{g}: {summary.get('completed')}/{p.num_prompts} ok in {t1 - t0:.1f} s; "
                    f"p50 TTFT {_f(summary.get('median_ttft_ms'))} ms, p50 TPOT {_f(summary.get('median_tpot_ms'))} ms; "
                    f"prefix hits +{_f(rec['counters'][HITS], '.0f')}, preemptions +{_f(rec['counters'][PREEMPTIONS], '.0f')}"
                )
            else:
                self.out(f"    gpu{g}: bench exited {proc.returncode} without a result; see local/{Path(b['result']).stem}.log")
        self._overload_check(s, p, t1 - t0)

    def _overload_check(self, s: Step, p, duration: float) -> None:
        rule = s.data.get("overload_stop")
        if not rule or math.isinf(p.request_rate):
            return
        nominal = p.num_prompts / p.request_rate
        group = s.data["group"]
        if duration > rule.duration_ratio * nominal:
            self._overloaded[group] = self._overloaded.get(group, 0) + 1
            self.out(f"    overloaded: {duration:.0f} s vs {nominal:.0f} s of arrivals ({self._overloaded[group]}/{rule.consecutive})")
            if self._overloaded[group] >= rule.consecutive:
                self._skip_groups.add(group)
                self.flags.append(Flag("overload_stop", "info", f"{group}: stopped after {p.id}; the queue kept growing", {"point": p.id}))
        else:
            self._overloaded[group] = 0

    def _counters(self, gpu: int) -> dict:
        from .plan import url

        try:
            fams = fetch_metrics(url(self.e, gpu, "/metrics"), timeout=10)
        except Exception:
            return {n: None for n in COUNTERS}
        return {n: prom.scalar(fams, n) for n in COUNTERS}

    def _do_server_stop(self, s: Step) -> None:
        srv = self.servers.pop(s.gpu, None)
        if not srv:
            return
        code = srv.stop(self.e.stop_timeout_s)
        self._record_server(srv)
        self.out(f"    exited with code {code}")
        self._wait_gpu_released(s.gpu)

    def _wait_gpu_released(self, gpu: int, timeout: float = 60.0) -> None:
        from . import nvml

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (nvml.memory_used_mib(gpu) or 0) < 2048:
                return
            time.sleep(1)
        self.flags.append(Flag("gpu_memory_not_released", "warning", f"GPU {gpu} still holds memory 60 s after vLLM exited"))

    def _record_server(self, srv: VllmServer) -> None:
        rec = srv.summary()
        rec["port"] = self.e.port(srv.gpu)
        rec["numa_node"] = self.e.numa[srv.gpu]
        rec["raw_log"] = srv.raw_log.name
        # Committed copy of the log, scrubbed; the raw one stays in local/.
        copy = self.dir / srv.raw_log.name
        try:
            manifest.scrub_file(srv.raw_log, copy, self.scrubber)
            rec["log_file"] = copy.name
        except OSError:
            rec["log_file"] = None
        self.server_records.append(rec)

    def _do_privileged(self, s: Step) -> None:
        self._confirm_n += 1
        sentinel = self.local / f"confirm-{self._confirm_n:02d}-{s.data['label']}"
        before = hostinfo.meminfo().get("Cached")
        bar = "=" * 78
        self.out(bar)
        self.out(f"AUTHOR ACTION REQUIRED ({s.title}). The harness will not run these itself.")
        self.out("Run them in your own terminal, in this order:\n")
        for c in s.data["commands"]:
            self.out(f"    {c}")
        self.out(f"\nThen confirm with:  touch {sentinel}")
        if sys.stdin.isatty():
            self.out("  (or type 'done' here; 'abort' stops the run)")
        self.out(bar)
        while True:
            self._wait_confirm(sentinel)
            problems = self._verify(s.data.get("verify", {}))
            if not problems:
                break
            self.out("Verification failed: " + "; ".join(problems) + ". Fix it and confirm again.")
            sentinel.unlink(missing_ok=True)
        after = hostinfo.meminfo().get("Cached")
        entry = {
            "label": s.data["label"],
            "commands": s.data["commands"],
            "confirmed_at": utc(),
            "page_cache_kib_before": before,
            "page_cache_kib_after": after,
        }
        if s.data.get("verify", {}).get("drop_caches") and before and after and after > 0.5 * before:
            entry["warning"] = "page cache did not shrink by half; were caches dropped?"
            self.flags.append(Flag("drop_caches_unverified", "warning", f"{s.data['label']}: page cache {before} -> {after} KiB"))
        self.privileged_log.append(entry)

    def _wait_confirm(self, sentinel: Path) -> None:
        last_note = time.monotonic()
        while not sentinel.exists():
            if sys.stdin.isatty():
                ready, _, _ = select.select([sys.stdin], [], [], 1.0)
                if ready:
                    line = sys.stdin.readline().strip().lower()
                    if line in ("done", "y", "yes"):
                        return
                    if line == "abort":
                        raise Aborted("author aborted at a privileged step")
            else:
                time.sleep(1.0)
            if time.monotonic() - last_note > 300:
                self.out(f"  still waiting for {sentinel.name} ...")
                last_note = time.monotonic()

    @staticmethod
    def _verify(verify: dict) -> list[str]:
        problems = []
        if "path_absent" in verify and Path(os.path.expanduser(verify["path_absent"])).exists():
            problems.append(f"{verify['path_absent']} still exists")
        if "path_present" in verify and not Path(os.path.expanduser(verify["path_present"])).exists():
            problems.append(f"{verify['path_present']} is missing")
        return problems

    def _do_check(self, s: Step) -> None:
        if s.data["name"] == "prefix_cache_zero":
            new = check_prefix_cache_zero(self.windows, self.plan.run.id)
        else:
            new = check_no_preemption(self.windows, self.plan.run.id)
        for f in new:
            self.out(f"    FLAG {f.code}: {f.message}")
        if not new:
            self.out("    ok")
        self.flags += new

    def _do_manifest(self, s: Step) -> None:
        pass  # written in run() after cleanup, whatever the outcome

    # ------------------------------------------------------------------ teardown
    def _cleanup(self) -> None:
        for sc in list(self.scrapers.values()):
            sc.stop()
        self.scrapers.clear()
        for g, srv in list(self.servers.items()):
            try:
                srv.stop(self.e.stop_timeout_s)
                self._record_server(srv)
            except Exception:
                pass
        self.servers.clear()
        if self.nvml:
            self.nvml.stop()
            self.nvml = None
        for w in (self.metrics_writer, self.nvml_writer):
            if w:
                w.close()

    def _write_manifest(self, started: float, ended: float, status: str, error: str | None) -> dict:
        run = self.plan.run
        nvml_rows = _read_jsonl(self.dir / "nvml.jsonl")
        for p in self.points:
            if "started_epoch_s" in p:
                p["power"] = power_cap_summary(nvml_rows, p["gpu"], p["started_epoch_s"], p["ended_epoch_s"])
        serve_env = safe_env({"CUDA_VISIBLE_DEVICES": "<per GPU>", **self.e.env})
        src = run.source.read_bytes()
        m = {
            "schema_version": manifest.SCHEMA_VERSION,
            "run_id": self.plan.run_id,
            "run_type": run.id,
            "title": run.title,
            "kind": run.kind,
            "purpose": run.purpose,
            "feeds": run.feeds,
            "status": status,
            "error": error,
            "started_at": utc(started),
            "ended_at": utc(ended),
            "duration_s": round(ended - started, 1),
            "gpus": list(run.gpus),
            "overrides": run.overrides,
            "harness": {
                "version": __version__,
                "git": hostinfo.git_info(),
                "argv": [os.path.basename(self.argv[0])] + list(self.argv[1:]),
                "run_config": display_path(str(run.source)),
                "run_config_sha256": hashlib.sha256(src).hexdigest(),
            },
            "versions": hostinfo.versions(),
            "hardware": hostinfo.hardware(),
            "engine": {
                "args": self.e.args_dict(),
                "env": serve_env,
                "numa": {f"gpu{g}": n for g, n in self.e.numa.items()},
                "info": self.engine_info,
            },
            "servers": self.server_records,
            "cold_start": _cold_start_table(self.server_records) if run.kind == "cold_start" else None,
            "points": self.points,
            "privileged_steps": self.privileged_log,
            "checks": {
                "prefix_cache_must_be_zero": run.prefix_cache_must_be_zero,
                "prefix_cache_zero": (
                    not any(f.code in ("prefix_cache_hits_nonzero", "prefix_cache_unverified") for f in self.flags)
                    if run.prefix_cache_must_be_zero
                    else None
                ),
            },
            "flags": [f.to_dict() for f in self.flags],
            "files": {
                "metrics": "metrics.jsonl" if (self.dir / "metrics.jsonl").exists() else None,
                "nvml": "nvml.jsonl" if (self.dir / "nvml.jsonl").exists() else None,
                "bench": sorted(p["bench_file"] for p in self.points if p.get("bench_file")),
                "server_logs": [r.get("log_file") for r in self.server_records if r.get("log_file")],
            },
        }
        path = self.dir / "manifest.json"
        clean = manifest.write_manifest(path, m, self.scrubber)
        self.out(f"manifest: {display_path(str(path))} (status {status}, {len(self.flags)} flag(s))")
        return clean


def _f(v, spec: str = ".1f") -> str:
    return format(v, spec) if isinstance(v, (int, float)) else "n/a"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with open(path) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def _resolved(cfg) -> dict | None:
    if not isinstance(cfg, dict):
        return None
    out = {}
    for section, keys in RESOLVED_KEYS.items():
        sec = cfg.get(section)
        if isinstance(sec, dict):
            out[section] = {k: sec.get(k) for k in keys if k in sec}
    return out


def _system_env(env: dict) -> dict:
    keep = ("torch_version", "cuda_compiled_version", "cuda_runtime_version", "cudnn_version", "nvidia_driver_version",
            "gpu_models_and_configuration", "python_version", "os", "vllm_version", "is_cuda_available")
    return {k: env.get(k) for k in keep if k in env}


def _cold_start_table(records: list[dict]) -> list[dict]:
    rows = []
    for r in records:
        label = r.get("label", "")
        if label in ("prime",) or "-" not in label:
            continue
        cond, _, trial = label.rpartition("-")
        ms = r.get("phases_ms_from_start", {})
        rows.append(
            {
                "condition": cond,
                "trial": int(trial) if trial.isdigit() else trial,
                "weights_loaded_ms": ms.get("weights_loaded"),
                "model_loaded_ms": ms.get("model_loaded"),
                "engine_init_done_ms": ms.get("engine_init_done"),
                "app_startup_complete_ms": ms.get("app_startup_complete"),
                "health_ok_ms": ms.get("health_ok"),
                "first_token_ms": ms.get("first_token"),
                "first_request_done_ms": ms.get("first_request_done"),
                "compile_cache": r.get("compile_cache"),
                "weights_load_s": r.get("values", {}).get("weights_load_s"),
                "torch_compile_s": r.get("values", {}).get("torch_compile_s"),
                "graph_capture_s": r.get("values", {}).get("graph_capture_s"),
            }
        )
    return rows
