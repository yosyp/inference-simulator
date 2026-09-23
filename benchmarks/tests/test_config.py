"""Run-config loading and validation, for the committed R0-R8 files and for broken ones."""

from __future__ import annotations

import math
import shutil
import textwrap
from pathlib import Path

import pytest

from harness import RUNS_DIR
from harness.config import ConfigError, apply_overrides, load_all, load_engine, load_run, parse_set


@pytest.fixture(scope="module")
def committed():
    return load_all()


@pytest.fixture
def engine():
    return load_engine(RUNS_DIR / "engine.toml")


def write_run(tmp_path: Path, run_id: str, body: str) -> Path:
    p = tmp_path / f"{run_id}.toml"
    p.write_text(textwrap.dedent(body))
    return p


SWEEP_HEAD = """\
id = "{id}"
title = "t"
purpose = "p"
kind = "sweep"
gpus = [0]
"""


def sweep(run_id: str, points: str, extra: str = "", defaults: str = 'dataset = "random"\noutput_len = 16') -> str:
    return SWEEP_HEAD.format(id=run_id) + extra + f"\n[defaults]\n{defaults}\n\n[[sweeps]]\nname = \"s\"\npoints = [\n{points}\n]\n"


# ------------------------------------------------------------------ committed runs


def test_all_committed_runs_load(committed):
    engine, runs = committed
    assert [r.id for r in runs] == [f"R{i}" for i in range(9)]
    assert engine.max_model_len == 131072 and engine.enable_prefix_caching and engine.enable_chunked_prefill
    assert engine.tensor_parallel_size == 1 and engine.gpu_memory_utilization == 0.9
    assert engine.numa == {0: 0, 1: 1}


def test_r1_r2_must_check_prefix_cache(committed):
    _, runs = committed
    by_id = {r.id: r for r in runs}
    assert by_id["R1"].prefix_cache_must_be_zero and by_id["R2"].prefix_cache_must_be_zero


def test_r1_covers_128_to_120k(committed):
    _, runs = committed
    r1 = next(r for r in runs if r.id == "R1")
    lens = [p.input_len for p in r1.points()]
    assert min(lens) == 128 and max(lens) == 120000 and lens == sorted(lens)
    assert all(p.max_concurrency == 1 and math.isinf(p.request_rate) for p in r1.points())


def test_seeds_unique_within_each_run(committed):
    _, runs = committed
    for r in runs:
        seeds = [p.seed for p in r.points()]
        assert len(seeds) == len(set(seeds)), r.id


def test_hold_s_sets_num_prompts(committed):
    _, runs = committed
    r3 = next(r for r in runs if r.id == "R3")
    p = r3.points()[0]
    assert p.hold_s == 180 and p.num_prompts == math.ceil(p.request_rate * 180)


def test_r7_conditions(committed):
    _, runs = committed
    r7 = next(r for r in runs if r.id == "R7")
    assert [c.name for c in r7.conditions] == ["process_restart", "host_reboot", "replacement_host"]
    assert r7.conditions[2].privileged == ("drop_caches", "compile_cache_aside")


# ------------------------------------------------------------------ broken runs


@pytest.mark.parametrize(
    "points, extra, defaults, message",
    [
        ('{ input_len = 128, num_prompts = 4, bogus = 1 }', "", 'dataset = "random"\noutput_len = 16', "unknown key"),
        ('{ input_len = 128 }', "", 'dataset = "random"\noutput_len = 16', "exactly one of num_prompts or hold_s"),
        ('{ input_len = 128, num_prompts = 4, hold_s = 10, request_rate = 1 }', "", 'dataset = "random"\noutput_len = 16', "exactly one"),
        ('{ input_len = 128, hold_s = 10 }', "", 'dataset = "random"\noutput_len = 16', "finite request_rate"),
        ('{ input_len = 131000, num_prompts = 1 }', "", 'dataset = "random"\noutput_len = 512', "max_model_len"),
        ('{ num_prompts = 4 }', "", 'dataset = "random"\noutput_len = 16', "input_len"),
        ('{ input_len = 128, num_prompts = 4 }', "", 'dataset = "bogus"\noutput_len = 16', "dataset"),
        ('{ input_len = 128, num_prompts = 4, request_rate = "fast" }', "", 'dataset = "random"\noutput_len = 16', "request_rate"),
        ('{ input_len = 128, num_prompts = 4, request_rate = -1 }', "", 'dataset = "random"\noutput_len = 16', "request_rate"),
        ('{ input_len = 128, num_prompts = 4, max_concurrency = 0 }', "", 'dataset = "random"\noutput_len = 16', "max_concurrency"),
        ('{ input_len = 128, num_prompts = 4, range_ratio = 1.5 }', "", 'dataset = "random"\noutput_len = 16', "range_ratio"),
        ('{ input_len = 128, num_prompts = 4, prefix_len = 64 }', "", 'dataset = "unique"\noutput_len = 16', "unique dataset"),
        (
            '{ id = "a", input_len = 128, num_prompts = 4 },\n{ id = "a", input_len = 256, num_prompts = 4 }',
            "",
            'dataset = "random"\noutput_len = 16',
            "duplicate point id",
        ),
        (
            '{ input_len = 128, num_prompts = 4, seed = 7 },\n{ input_len = 256, num_prompts = 4, seed = 7 }',
            "",
            'dataset = "random"\noutput_len = 16',
            "duplicate seed",
        ),
        (
            '{ num_prompts = 4, prefix_repetition = { prefix_len = 64, suffix_len = 64, num_prefixes = 8 } }',
            "",
            'dataset = "prefix_repetition"\noutput_len = 16',
            "num_prefixes",
        ),
        (
            '{ request_rate = 1, hold_s = 10, lognormal = { input_median = 10, input_sigma = 1, input_min = 20, input_max = 30, output_median = 10, output_sigma = 1, output_min = 1, output_max = 20 } }',
            "",
            'dataset = "lognormal"',
            "input_min <= input_median",
        ),
    ],
)
def test_invalid_points_rejected(tmp_path, engine, points, extra, defaults, message):
    path = write_run(tmp_path, "R4", sweep("R4", points, extra, defaults))
    with pytest.raises(ConfigError, match=message):
        load_run(path, engine)


def test_kv_overflow_needs_expect_preemption(tmp_path, engine):
    pts = "{ input_len = 4096, output_len = 4096, max_concurrency = 64, num_prompts = 64 }"
    with pytest.raises(ConfigError, match="does not\nexpect preemption|does not expect preemption"):
        load_run(write_run(tmp_path, "R4", sweep("R4", pts)), engine)
    ok = load_run(write_run(tmp_path, "R4", sweep("R4", pts, extra="expect_preemption = true\n")), engine)
    assert ok.points()[0].max_concurrency == 64


def test_r1_without_prefix_check_rejected(tmp_path, engine):
    path = write_run(tmp_path, "R1", sweep("R1", "{ input_len = 128, num_prompts = 4 }"))
    with pytest.raises(ConfigError, match="prefix_cache_must_be_zero"):
        load_run(path, engine)


def test_id_must_match_file_name(tmp_path, engine):
    p = tmp_path / "R5.toml"
    p.write_text(sweep("R4", "{ input_len = 128, num_prompts = 4 }"))
    with pytest.raises(ConfigError, match="id must match"):
        load_run(p, engine)


def test_sweep_uses_one_gpu(tmp_path, engine):
    body = sweep("R4", "{ input_len = 128, num_prompts = 4 }").replace("gpus = [0]", "gpus = [0, 1]")
    with pytest.raises(ConfigError, match="exactly one GPU"):
        load_run(write_run(tmp_path, "R4", body), engine)


def test_unknown_gpu_rejected(tmp_path, engine):
    body = sweep("R4", "{ input_len = 128, num_prompts = 4 }").replace("gpus = [0]", "gpus = [3]")
    with pytest.raises(ConfigError, match="gpus"):
        load_run(write_run(tmp_path, "R4", body), engine)


def test_cold_start_rejects_unknown_privileged_step(tmp_path, engine):
    body = """\
    id = "R7"
    title = "t"
    purpose = "p"
    kind = "cold_start"
    gpus = [0]
    [[conditions]]
    name = "x"
    privileged = ["reboot_the_box"]
    """
    with pytest.raises(ConfigError, match="unknown privileged"):
        load_run(write_run(tmp_path, "R7", body), engine)


def test_independence_needs_a_joint_phase(tmp_path, engine):
    body = """\
    id = "R8"
    title = "t"
    purpose = "p"
    kind = "independence"
    gpus = [0, 1]
    phases = [[0], [1]]
    [[sweeps]]
    name = "s"
    points = [ { dataset = "random", input_len = 128, output_len = 16, num_prompts = 4 } ]
    """
    with pytest.raises(ConfigError, match="all GPUs together"):
        load_run(write_run(tmp_path, "R8", body), engine)


def test_engine_rejects_tp_and_remote_host(tmp_path):
    src = (RUNS_DIR / "engine.toml").read_text()
    p = tmp_path / "engine.toml"
    p.write_text(src.replace("tensor_parallel_size = 1", "tensor_parallel_size = 2"))
    with pytest.raises(ConfigError, match="tensor_parallel_size"):
        load_engine(p)
    p.write_text(src.replace('host = "127.0.0.1"', 'host = "0.0.0.0"'))
    with pytest.raises(ConfigError, match="loopback"):
        load_engine(p)


# ------------------------------------------------------------------ overrides


def test_overrides_rate_scale_and_set(committed):
    engine, runs = committed
    r3 = next(r for r in runs if r.id == "R3")
    scaled = apply_overrides(r3, engine, rate_scale=0.5)
    p0, q0 = r3.points()[0], scaled.points()[0]
    assert q0.request_rate == p0.request_rate * 0.5
    assert q0.num_prompts == math.ceil(q0.request_rate * q0.hold_s)
    assert scaled.overrides == {"rate_scale": 0.5}

    r5 = next(r for r in runs if r.id == "R5")
    set5 = apply_overrides(r5, engine, sets=parse_set(["request_rate=13.5"]))
    assert set5.points()[0].request_rate == 13.5
    assert set5.points()[0].num_prompts == math.ceil(13.5 * 600)


def test_override_gpus(committed):
    engine, runs = committed
    r1 = next(r for r in runs if r.id == "R1")
    assert apply_overrides(r1, engine, gpus=(1,)).gpus == (1,)
    r8 = next(r for r in runs if r.id == "R8")
    with pytest.raises(ConfigError):
        apply_overrides(r8, engine, gpus=(0,))  # R8 needs both GPUs


def test_parse_set_rejects_unknown_keys():
    with pytest.raises(ConfigError, match="not overridable"):
        parse_set(["model=other"])
    with pytest.raises(ConfigError, match="KEY=VALUE"):
        parse_set(["request_rate"])


def test_runs_dir_copy_is_self_contained(tmp_path):
    """The loader only needs the runs directory (used by --runs-dir)."""
    dst = tmp_path / "runs"
    shutil.copytree(RUNS_DIR, dst)
    _, runs = load_all(dst)
    assert len(runs) == 9
