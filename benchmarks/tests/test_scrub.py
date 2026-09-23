"""Manifest scrubbing: nothing host-identifying reaches a committed file."""

from __future__ import annotations

import json

import pytest

from harness.manifest import ManifestLeak, postprocess_bench, scrub_file, write_manifest
from harness.scrub import Scrubber, safe_env
from conftest import FIXTURES


@pytest.fixture
def s() -> Scrubber:
    return Scrubber(
        home="/home/alice",
        user="alice",
        hostnames={"gpu-box-17.lab.example.com"},
        host_ips={"203.0.113.9"},
        repo_root="/home/alice/alice-projects/inference-simulator",
    )


def test_checkout_path_becomes_repo(s):
    line = "/home/alice/alice-projects/inference-simulator/benchmarks/.venv/lib/python3.12/site-packages/torch/x.py:12: UserWarning"
    assert s.text(line) == "<repo>/benchmarks/.venv/lib/python3.12/site-packages/torch/x.py:12: UserWarning"


def test_home_paths_become_tilde(s):
    assert s.text("/home/alice/.cache/vllm/torch_compile_cache/3f2a") == "~/.cache/vllm/torch_compile_cache/3f2a"
    assert s.text("cache_dir='/home/bob/x'") == "cache_dir='~/x'"  # any home, not just ours
    assert s.text("/Users/carol/models") == "~/models"
    assert s.text("/root/.cache/huggingface") == "~/.cache/huggingface"
    assert s.text("/rootfs/data") == "/rootfs/data"


def test_hostnames_and_usernames(s):
    assert s.text("running on gpu-box-17.lab.example.com now") == "running on <host> now"
    assert s.text("GPU-BOX-17 says hi") == "<host> says hi"
    assert s.text("alice@gpu-box-17") == "<user>@<host>"
    assert s.text("owner alice, group alice") == "owner <user>, group <user>"
    assert s.text("malice aforethought") == "malice aforethought"  # whole words only


def test_generic_username_scrubbed_only_in_paths():
    g = Scrubber(home="/home/user", user="user", hostnames=set(), host_ips=set())
    assert g.text("user-specified value; /home/user/.cache") == "user-specified value; ~/.cache"
    assert g.text("user@somewhere") == "<user>@somewhere"


def test_tokens_and_hardware_ids(s):
    hf = "hf_" + "a1B2c3D4e5F6g7H8i9J0kLmN"
    gh = "ghp_" + "A" * 36
    assert s.text(f"token={hf}") == "token=<redacted-token>"
    assert s.text(f"Authorization: Bearer {'x' * 40}") == "Authorization: <redacted-token>"
    assert gh not in s.text(gh)
    assert s.text("AKIAABCDEFGHIJKLMNOP") == "<redacted-token>"
    assert s.text("GPU-5b1f3c2a-1111-2222-3333-444455556666") == "<gpu-uuid>"
    assert s.text("link/ether 3c:ec:ef:12:34:56") == "link/ether <mac>"


def test_ips_scrubbed_but_versions_and_loopback_kept(s):
    assert s.text("distributed_init_method=tcp://10.20.30.40:41235") == "distributed_init_method=tcp://<ip>:41235"
    assert s.text("from 192.168.1.5 and 172.16.9.1") == "from <ip> and <ip>"
    assert s.text("public 203.0.113.9") == "public <ip>"  # this host's own address
    assert s.text("http://127.0.0.1:8001 and 0.0.0.0") == "http://127.0.0.1:8001 and 0.0.0.0"
    assert s.text("cudnn 9.19.0.56, driver 580.159.04") == "cudnn 9.19.0.56, driver 580.159.04"


def test_obj_redacts_secret_keys_but_keeps_token_counts(s):
    out = s.obj(
        {
            "hf_token": "abc",
            "api_key": "xyz",
            "HF_TOKEN_PATH": "/home/alice/.cache/huggingface/token",
            "max_num_batched_tokens": 2048,
            "total_input_tokens": 12345,
            "tokenizer_id": "meta-llama/Llama-3.1-8B-Instruct",
            "nested": [{"password": "p", "path": "/home/alice/x"}],
            "empty_token": "",
            "phases_ms_from_start": {"first_token": 812.5, "health_ok": 790.0},
        }
    )
    assert out["phases_ms_from_start"] == {"first_token": 812.5, "health_ok": 790.0}  # numbers are not secrets
    assert out["hf_token"] == "<redacted>"
    assert out["api_key"] == "<redacted>"
    assert out["HF_TOKEN_PATH"] == "<redacted>"
    assert out["max_num_batched_tokens"] == 2048
    assert out["total_input_tokens"] == 12345
    assert out["tokenizer_id"] == "meta-llama/Llama-3.1-8B-Instruct"
    assert out["nested"] == [{"password": "<redacted>", "path": "~/x"}]
    assert out["empty_token"] == ""


def test_leaks_detects_and_scrub_clears(s):
    dirty = "log at /home/alice/x on gpu-box-17 from 10.1.2.3 by alice"
    assert set(s.leaks(dirty)) >= {"home directory path", "hostname", "username", "IP address"}
    assert s.leaks(s.text(dirty)) == []


def test_write_manifest_scrubs(tmp_path, s):
    m = {
        "run_id": "R0-20260923T051000Z",
        "harness": {"argv": ["/home/alice/proj/benchmarks/.venv/bin/harness", "run", "R0"]},
        "engine": {"info": {"cache_dir": "/home/alice/.cache/vllm/torch_compile_cache/3f2a"}},
        "hardware": {"gpu_topology": "GPU0 X SYS gpu-box-17"},
        "value": float("nan"),
    }
    clean = write_manifest(tmp_path / "manifest.json", m, s)
    text = (tmp_path / "manifest.json").read_text()
    assert "/home/alice" not in text and "gpu-box-17" not in text and "alice" not in text
    assert json.loads(text) == clean
    assert clean["value"] is None  # NaN is not valid JSON


def test_write_manifest_refuses_when_scrubbing_misses_something(tmp_path, s):
    class Broken(Scrubber):
        def obj(self, o):  # a regression that stops scrubbing
            return o

    b = Broken(home=s.home, user=s.user, hostnames=s.hostnames, host_ips=s.host_ips)
    with pytest.raises(ManifestLeak):
        write_manifest(tmp_path / "manifest.json", {"path": "/home/alice/secret"}, b)
    assert not (tmp_path / "manifest.json").exists()


def test_safe_env_allowlist():
    env = {
        "CUDA_VISIBLE_DEVICES": "0",
        "VLLM_SERVER_DEV_MODE": "1",
        "HF_HUB_OFFLINE": "1",
        "HF_TOKEN": "hf_secret",
        "VLLM_API_KEY": "k",
        "HOME": "/home/alice",
        "PATH": "/usr/bin",
    }
    assert safe_env(env) == {"CUDA_VISIBLE_DEVICES": "0", "HF_HUB_OFFLINE": "1", "VLLM_SERVER_DEV_MODE": "1"}


def test_postprocess_bench_drops_texts_and_scrubs(tmp_path, s):
    p = tmp_path / "bench-in128.json"
    p.write_text(
        json.dumps(
            {
                "completed": 30,
                "failed": 0,
                "median_ttft_ms": 41.2,
                "tokenizer_id": "/home/alice/models/llama",
                "generated_texts": ["x"] * 30,
                "output_lens": [1] * 30,
            }
        )
    )
    summary = postprocess_bench(p, s, drop_generated_texts=True)
    data = json.loads(p.read_text())
    assert "generated_texts" not in data and data["output_lens"] == [1] * 30
    assert data["tokenizer_id"] == "~/models/llama"
    assert summary == {"completed": 30, "failed": 0, "median_ttft_ms": 41.2}


def test_scrubbed_server_log_copy(tmp_path, s):
    dst = tmp_path / "server.log"
    scrub_file(FIXTURES / "vllm_startup_cold.log", dst, s)
    text = dst.read_text()
    assert s.leaks(text) == []
    assert "~/.cache/vllm/torch_compile_cache/3f2a9c1d7e" in text
    assert "tcp://<ip>:41235" in text
    assert "GPU KV cache size: 143,696 tokens" in text  # data survives
