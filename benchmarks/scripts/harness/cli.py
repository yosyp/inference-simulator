"""`harness` command line. `harness plan all` (or `harness run all --dry-run`) prints the full
R0-R8 plan without touching a GPU. Real runs need `--gpu-approved` (00-build Track B, K10)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from . import PROJECT_ROOT, RAW_DIR, RUNS_DIR
from .config import ConfigError, apply_overrides, load_all, parse_set, select
from .estimate import gpus_reserved, run_s
from .plan import build_plan, render

EXIT_CONFIG, EXIT_NOT_APPROVED, EXIT_PREFLIGHT, EXIT_RUN_FAILED = 1, 2, 3, 4


def _gpus(text: str | None) -> tuple[int, ...] | None:
    if not text:
        return None
    try:
        return tuple(int(x) for x in text.split(","))
    except ValueError:
        raise ConfigError(f"--gpus expects a comma-separated list like 0,1, got '{text}'")


def _load(args) -> tuple:
    engine, runs = load_all(Path(args.runs_dir))
    selected = select(runs, args.runs)
    sets = parse_set(args.set or [])
    gpus = _gpus(args.gpus)
    return engine, [apply_overrides(r, engine, gpus=gpus, sets=sets, rate_scale=args.rate_scale) for r in selected]


def _run_id(run_id_base: str, suffix: str | None, dry: bool) -> str:
    stamp = "YYYYMMDDTHHMMSSZ" if dry else dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{run_id_base}-{stamp}" + (f"-{suffix}" if suffix else "")


def cmd_list(args) -> int:
    engine, runs = load_all(Path(args.runs_dir))
    print(f"{'run':4} {'kind':13} {'gpus':6} {'points':>6} {'est. min':>8}  title")
    for r in runs:
        print(f"{r.id:4} {r.kind:13} {','.join(map(str, r.gpus)):6} {len(r.points()):>6} {run_s(r, engine) / 60:>8.0f}  {r.title}")
    return 0


def cmd_validate(args) -> int:
    engine, runs = load_all(Path(args.runs_dir))
    for r in runs:
        print(f"ok  {r.id}  {r.title}: {len(r.sweeps)} sweep(s), {len(r.points())} point(s)")
    print(f"ok  engine: {engine.model}, max_model_len {engine.max_model_len}")
    return 0


def cmd_plan(args) -> int:
    engine, runs = _load(args)
    out_dir = Path(args.out_dir) if args.out_dir else RAW_DIR
    total_s = total_gpu_h = 0.0
    rows = []
    print("DRY RUN: nothing below is executed. No process is started and no GPU is touched.")
    print(f"Engine (03 §3): {engine.model} {engine.dtype}, TP={engine.tensor_parallel_size}, "
          f"max_model_len {engine.max_model_len}, prefix caching {'on' if engine.enable_prefix_caching else 'off'}, "
          f"chunked prefill {'on' if engine.enable_chunked_prefill else 'off'}, gpu_memory_utilization {engine.gpu_memory_utilization:g}")
    print(f"NUMA pinning: " + ", ".join(f"GPU {g} -> node {n}" for g, n in sorted(engine.numa.items())) + "; port 8001 + GPU index\n")
    for r in runs:
        run_id = _run_id(r.id, args.run_id_suffix, dry=True)
        plan = build_plan(engine, r, run_id, out_dir / run_id)
        est = run_s(r, engine)
        print(render(plan, est))
        print()
        gh = est / 3600 * gpus_reserved(r)
        rows.append((r, est, gh))
        total_s += est
        total_gpu_h += gh
    print("Estimated duration (rough roofline with provisional eta_c 0.5, eta_b 0.8, t_o 4 ms; +/- 50%):")
    for r, est, gh in rows:
        print(f"  {r.id}  {est / 60:6.0f} min  {gh:5.2f} GPU-h  {r.title}")
    print(f"  total {total_s / 3600:5.1f} h wall, {total_gpu_h:5.2f} GPU-h active; "
          f"keeping both GPUs free for the whole campaign books {2 * total_s / 3600:4.1f} GPU-h")
    return 0


def cmd_preflight(args) -> int:
    from . import preflight
    from .config import load_engine

    engine = load_engine(Path(args.runs_dir) / "engine.toml")
    gpus = list(_gpus(args.gpus) or (0, 1))
    results = preflight.run_all(engine, gpus, with_gpu=not args.no_gpu)
    print("Preflight (read-only):")
    print(preflight.format_results(results))
    return 0 if all(r.ok for r in results) else EXIT_PREFLIGHT


def cmd_run(args) -> int:
    if args.dry_run:
        return cmd_plan(args)
    engine, runs = _load(args)
    if not args.gpu_approved:
        print("Refusing to start: real runs use the GPUs and need the author's approval (00-build Track B, K10).")
        print("Ask the author, confirm both GPUs are free (`nvidia-smi`), then rerun with --gpu-approved.")
        print("To see what would run: add --dry-run.")
        return EXIT_NOT_APPROVED

    from . import preflight
    from .executor import Executor

    gpus = sorted({g for r in runs for g in r.gpus})
    results = preflight.run_all(engine, gpus)
    print("Preflight:")
    print(preflight.format_results(results))
    blocking = [r for r in results if not r.ok and r.blocking]
    if args.allow_busy_gpus:
        blocking = [r for r in blocking if not r.name.endswith("_free")]
    if blocking:
        print("Preflight failed; nothing started." + ("" if args.allow_busy_gpus else " (--allow-busy-gpus overrides only the GPU-free check.)"))
        return EXIT_PREFLIGHT

    out_dir = Path(args.out_dir) if args.out_dir else RAW_DIR
    worst = 0
    for r in runs:
        run_id = _run_id(r.id, args.run_id_suffix, dry=False)
        plan = build_plan(engine, r, run_id, out_dir / run_id)
        print(render(plan, run_s(r, engine)))
        m = Executor(engine, plan).run()
        errors = [f for f in m.get("flags", []) if f.get("severity") == "error"]
        print(f"{r.id}: {m['status']}; {len(m.get('flags', []))} flag(s), {len(errors)} error(s)")
        if m["status"] != "complete":
            return EXIT_RUN_FAILED
        worst = max(worst, 1 if errors else 0)
    return EXIT_RUN_FAILED if worst else 0


def cmd_check(args) -> int:
    """Re-run the prefix-cache check on a finished run directory from metrics.jsonl."""
    from .checks import check_prefix_cache_zero, windows_from_metrics

    run_dir = Path(args.run_dir)
    man = json.loads((run_dir / "manifest.json").read_text())
    rows = []
    with open(run_dir / "metrics.jsonl") as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    windows = windows_from_metrics(rows, [p for p in man.get("points", []) if not p.get("skipped")])
    flags = check_prefix_cache_zero(windows, man.get("run_type", "?"))
    for f in flags:
        print(f"FLAG {f.code}: {f.message}")
    print(f"{len(windows)} point(s) checked, {len(flags)} flag(s)")
    return 1 if flags else 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="harness", description=__doc__)
    p.add_argument("--runs-dir", default=str(RUNS_DIR), help="directory with engine.toml and R*.toml")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list run definitions").set_defaults(func=cmd_list)
    sub.add_parser("validate", help="validate engine.toml and every run file").set_defaults(func=cmd_validate)

    def plan_args(sp):
        sp.add_argument("runs", nargs="*", default=["all"], help="run ids (R0 ... R8) or 'all'")
        sp.add_argument("--gpus", help="override the run's GPUs, e.g. 1 or 0,1")
        sp.add_argument("--set", action="append", metavar="KEY=VALUE", help="override a point field for every point (request_rate, hold_s, num_prompts, max_concurrency, burstiness, cooldown_s)")
        sp.add_argument("--rate-scale", type=float, help="multiply every finite request rate (place R3-R5 around the measured knee)")
        sp.add_argument("--run-id-suffix", help="appended to the run id")
        sp.add_argument("--out-dir", help=f"where run directories go (default {RAW_DIR.relative_to(PROJECT_ROOT)})")

    sp = sub.add_parser("plan", help="print every command a run would execute (dry run)")
    plan_args(sp)
    sp.set_defaults(func=cmd_plan, dry_run=True)

    sp = sub.add_parser("run", help="run benchmarks (needs --gpu-approved) or print them (--dry-run)")
    plan_args(sp)
    sp.add_argument("--dry-run", action="store_true", help="print the plan and exit; touches nothing")
    sp.add_argument("--gpu-approved", action="store_true", help="the author approved GPU use for this run")
    sp.add_argument("--allow-busy-gpus", action="store_true", help="start even if another process holds GPU memory")
    sp.set_defaults(func=cmd_run)

    sp = sub.add_parser("preflight", help="read-only checks: weights, tools, ports, GPU occupancy (NVML)")
    sp.add_argument("--gpus", help="GPUs to check (default 0,1)")
    sp.add_argument("--no-gpu", action="store_true", help="skip the NVML queries")
    sp.set_defaults(func=cmd_preflight)

    sp = sub.add_parser("check", help="re-check prefix-cache hits for a finished run directory")
    sp.add_argument("run_dir")
    sp.set_defaults(func=cmd_check)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":
    sys.exit(main())
