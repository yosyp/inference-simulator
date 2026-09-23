"""The dry run: every run renders its full plan without starting a process or touching a GPU."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from harness import cli
from harness.config import load_all
from harness.estimate import point_s, run_s
from harness.plan import build_plan
from harness.scrub import Scrubber

RUN_IDS = [f"R{i}" for i in range(9)]


@pytest.fixture(scope="module")
def plans():
    engine, runs = load_all()
    return engine, {r.id: build_plan(engine, r, f"{r.id}-TEST", Path("/tmp/raw") / f"{r.id}-TEST") for r in runs}


def test_dry_run_all_prints_every_run(no_processes, capsys):
    assert cli.main(["run", "all", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("DRY RUN")
    for rid in RUN_IDS:
        assert f"== {rid} · " in out
    assert "total" in out and "GPU-h" in out
    assert "pynvml" not in sys.modules and "torch" not in sys.modules and "vllm" not in sys.modules


def test_plan_alias_and_single_run(no_processes, capsys):
    assert cli.main(["plan", "R1"]) == 0
    out = capsys.readouterr().out
    assert "== R1 · " in out and "== R2 · " not in out
    assert out.count("vllm bench serve") == 21  # 20 points + warmup


def test_dry_run_output_has_nothing_host_identifying(no_processes, capsys):
    cli.main(["plan", "all"])
    out = capsys.readouterr().out
    assert Scrubber().leaks(out) == []


def test_real_run_refused_without_approval(no_processes, capsys):
    assert cli.main(["run", "R0"]) == cli.EXIT_NOT_APPROVED
    assert "--gpu-approved" in capsys.readouterr().out


def test_unknown_run_is_a_config_error(no_processes, capsys):
    assert cli.main(["plan", "R42"]) == cli.EXIT_CONFIG


def test_every_plan_ends_with_the_manifest(plans):
    _, ps = plans
    for rid, p in ps.items():
        kinds = [s.kind for s in p.steps]
        assert kinds[0] == "mkdir" and kinds[1] == "nvml_start", rid
        assert kinds[-1] == "manifest", rid
        # every server that starts also stops
        assert kinds.count("server_start") == kinds.count("server_stop"), rid


def test_harness_never_runs_privileged_commands(plans):
    _, ps = plans
    for rid, p in ps.items():
        for s in p.steps:
            argvs = [s.command.argv] if s.command else []
            argvs += [b["command"].argv for b in s.data.get("benches", [])]
            for argv in argvs:
                joined = " ".join(argv)
                assert "sudo" not in argv and "drop_caches" not in joined and argv[0] != "mv", (rid, joined)
        privileged = [s for s in p.steps if s.kind == "privileged"]
        assert bool(privileged) == (rid == "R7"), rid


def test_r7_prints_drop_caches_and_compile_cache_moves(plans):
    _, ps = plans
    steps = [s for s in ps["R7"].steps if s.kind == "privileged"]
    cmds = [c for s in steps for c in s.data["commands"]]
    assert cmds.count("sync; echo 3 | sudo tee /proc/sys/vm/drop_caches") == 6  # 3 host_reboot + 3 replacement_host
    moves = [c for c in cmds if c.startswith("mv ")]
    assert moves[0].startswith("mv ~/.cache/vllm/torch_compile_cache ")
    assert moves[-1].endswith(" ~/.cache/vllm/torch_compile_cache")  # restored at the end
    assert steps[-1].data["verify"] == {"path_present": "~/.cache/vllm/torch_compile_cache"}
    # process_restart trials run before any privileged step
    labels = [s.data.get("label") for s in ps["R7"].steps if s.kind == "server_start"]
    assert labels[:4] == ["prime", "process_restart-1", "process_restart-2", "process_restart-3"]


def test_serve_command_pins_numa_and_uses_03_engine_flags(plans):
    engine, ps = plans
    starts = [s for p in ps.values() for s in p.steps if s.kind == "server_start"]
    for s in starts:
        a = s.command.argv
        node = engine.numa[s.gpu]
        assert a[:3] == ("numactl", f"--cpunodebind={node}", f"--membind={node}")
        assert a[4:6] == ("serve", "meta-llama/Llama-3.1-8B-Instruct")
        for flag in ("--enable-prefix-caching", "--enable-chunked-prefill"):
            assert flag in a
        assert a[a.index("--max-model-len") + 1] == "131072"
        assert a[a.index("--tensor-parallel-size") + 1] == "1"
        assert a[a.index("--port") + 1] == str(8001 + s.gpu)
        assert s.command.env["CUDA_VISIBLE_DEVICES"] == str(s.gpu)
        assert s.command.env["VLLM_SERVER_DEV_MODE"] == "1"


def test_bench_commands_save_detailed_results_into_the_run_dir(plans):
    _, ps = plans
    for rid, p in ps.items():
        for s in p.steps:
            benches = [{"command": s.command, "result": s.data["result"]}] if s.kind == "bench" else s.data.get("benches", [])
            for b in benches:
                a = b["command"].argv
                assert "--save-result" in a and "--save-detailed" in a and "--ignore-eos" in a
                result_dir = Path(a[a.index("--result-dir") + 1])
                assert str(result_dir).startswith(str(p.run_dir))
                assert result_dir / a[a.index("--result-filename") + 1] == Path(b["result"])
                assert b["command"].env["CUDA_VISIBLE_DEVICES"] == ""  # the client never sees a GPU


def test_r1_r2_reset_cache_before_each_point_and_check_hits(plans):
    _, ps = plans
    for rid in ("R1", "R2"):
        steps = ps[rid].steps
        for i, s in enumerate(steps):
            if s.kind == "bench" and not s.data.get("warmup"):
                prev = [x.kind for x in steps[max(0, i - 2) : i]]
                assert "reset_prefix_cache" in prev, (rid, s.title)
        checks = [s.data["name"] for s in steps if s.kind == "check"]
        assert "prefix_cache_zero" in checks


def test_generated_datasets_are_built_before_their_bench(plans):
    _, ps = plans
    for rid in ("R2", "R3", "R5"):
        steps = ps[rid].steps
        for i, s in enumerate(steps):
            if s.kind == "bench" and s.data["point"].dataset in ("unique", "lognormal"):
                gen = [x for x in steps[:i] if x.kind == "gen_dataset" and x.data["point"].id == s.data["point"].id]
                assert gen, (rid, s.data["point"].id)
                a = s.command.argv
                assert a[a.index("--dataset-path") + 1] == gen[0].data["path"]


def test_r8_runs_solo_then_both(plans):
    _, ps = plans
    steps = ps["R8"].steps
    parallel = [s for s in steps if s.kind == "bench_parallel"]
    solo = [s for s in steps if s.kind == "bench"]
    assert len(parallel) == 3 and len(solo) == 6
    for s in parallel:
        assert {b["gpu"] for b in s.data["benches"]} == {0, 1}
        files = [Path(b["result"]).name for b in s.data["benches"]]
        assert files[0].startswith("bench-both-gpu0-") and files[1].startswith("bench-both-gpu1-")


def test_estimates_are_finite_and_plausible():
    engine, runs = load_all()
    total = sum(run_s(r, engine) for r in runs)
    assert 1 * 3600 < total < 12 * 3600
    for r in runs:
        for p in r.points():
            assert 0 < point_s(p) < 3 * 3600, (r.id, p.id)
