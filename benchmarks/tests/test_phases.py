"""Startup-phase parser against realistic vLLM 0.20.1 log output."""

from __future__ import annotations

from harness.phases import PhaseTracker, parse_log, parse_stamped_log, strip_line
from conftest import FIXTURES


def _feed(name: str, t0: float = 1000.0, step: float = 1.0) -> PhaseTracker:
    lines = (FIXTURES / name).read_text().splitlines()
    return parse_log([(t0 + 1 + i * step, line) for i, line in enumerate(lines)], t0=t0)


def test_cold_start_log_yields_every_phase_in_order():
    tr = _feed("vllm_startup_cold.log")
    expected_order = [
        "process_start",
        "api_server_start",
        "max_model_len",
        "chunked_prefill_config",
        "engine_core_start",
        "model_load_start",
        "weights_loaded",
        "model_loaded",
        "compile_dynamo_done",
        "compile_graph_done",
        "compile_done",
        "kv_cache_memory",
        "kv_cache_size",
        "max_concurrency",
        "graph_capture_done",
        "engine_init_done",
        "api_listening",
        "app_startup_complete",
    ]
    order = [p for p in sorted(tr.phases, key=tr.phases.get) if p in expected_order]
    assert order == expected_order


def test_cold_start_log_values():
    v = _feed("vllm_startup_cold.log").values
    assert v["vllm_version"] == "0.20.1"
    assert v["engine_vllm_version"] == "0.20.1"
    assert v["max_model_len"] == 131072
    assert v["max_num_batched_tokens"] == 2048
    assert v["weights_load_s"] == 13.27
    assert v["model_load_gib"] == 14.9905
    assert v["model_load_s"] == 14.312187
    assert v["dynamo_s"] == 7.52
    assert v["compile_graph_s"] == 22.11
    assert v["torch_compile_s"] == 31.40
    assert v["kv_cache_gib"] == 17.54
    assert v["kv_cache_tokens"] == 143696  # thousands separator handled
    assert v["max_concurrency_tokens_per_request"] == 131072
    assert v["max_concurrency"] == 1.10
    assert v["graph_capture_s"] == 9
    assert v["graph_capture_gib"] == 0.61
    assert v["engine_init_s"] == 47.83
    assert v["listen_address"] == "http://127.0.0.1:8001"


def test_compile_cache_miss_vs_hit():
    cold = _feed("vllm_startup_cold.log").summary()
    warm = _feed("vllm_startup_warm.log").summary()
    assert cold["compile_cache"] == "miss"
    assert warm["compile_cache"] == "hit"
    assert warm["values"]["compile_cache_load_s"] == 1.874


def test_ansi_colors_and_process_prefix_are_stripped():
    warm = _feed("vllm_startup_warm.log")
    assert warm.values["weights_load_s"] == 2.84
    assert "app_startup_complete" in warm.phases
    msg, info = strip_line("\x1b[1;36m(EngineCore pid=77050)\x1b[0;0m \x1b[32mINFO\x1b[0m 09-23 06:00:13 [default_loader.py:385] Loading weights took 2.84 seconds")
    assert msg == "Loading weights took 2.84 seconds"
    assert info["proc"] == "EngineCore" and info["pid"] == "77050" and info["level"] == "INFO"
    assert info["src"] == "default_loader.py:385"


def test_offsets_are_ms_from_process_start():
    tr = PhaseTracker()
    tr.mark("process_start", 100.0)
    tr.feed(112.5, "INFO 09-23 05:10:36 [default_loader.py:385] Loading weights took 11.10 seconds")
    tr.mark("health_ok", 160.25)
    tr.mark("first_token", 160.5)
    off = tr.offsets_ms()
    assert off == {"process_start": 0.0, "weights_loaded": 12500.0, "health_ok": 60250.0, "first_token": 60500.0}


def test_first_occurrence_wins():
    tr = PhaseTracker()
    tr.feed(1.0, "(EngineCore_DP0 pid=1) INFO 09-23 05:11:15 [kv_cache_utils.py:1708] GPU KV cache size: 143,696 tokens")
    tr.feed(2.0, "(EngineCore_DP1 pid=2) INFO 09-23 05:11:16 [kv_cache_utils.py:1708] GPU KV cache size: 99 tokens")
    assert tr.phases["kv_cache_size"] == 1.0
    assert tr.values["kv_cache_tokens"] == 143696
    tr.mark("health_ok", 5.0)
    tr.mark("health_ok", 9.0)
    assert tr.phases["health_ok"] == 5.0


def test_wording_variants_across_releases():
    lines = [
        "INFO 05-01 10:00:00 [default_loader.py:272] Loading weights took 4.21 s",
        "INFO 05-01 10:00:01 [model_runner.py:291] Model loading took 14.99 GiB and 5.31 seconds",
        "INFO 05-01 10:00:02 [monitor.py:34] torch.compile takes 28.40 s in total",
        "INFO 05-01 10:00:03 [gpu_model_runner.py:2000] Graph capturing finished in 1 sec, took 0.50 GiB",
        "INFO 05-01 10:00:04 [core.py:90] init engine (profile, create kv cache, warmup model) took 45.83 seconds",
        "INFO 05-01 10:00:05 [api_server.py:1000] Starting vLLM API server 0 on http://127.0.0.1:8002",
        "INFO 05-01 10:00:06 [model_runner.py:260] Loading model from scratch...",
    ]
    tr = parse_log([(float(i), line) for i, line in enumerate(lines)])
    assert tr.values["weights_load_s"] == 4.21
    assert tr.values["model_load_gib"] == 14.99 and tr.values["model_load_s"] == 5.31
    assert tr.values["torch_compile_s"] == 28.40
    assert tr.values["graph_capture_s"] == 1
    assert tr.values["engine_init_s"] == 45.83
    assert tr.values["listen_address"] == "http://127.0.0.1:8002"
    assert "model_load_start" in tr.phases


def test_noise_lines_create_no_phases():
    tr = PhaseTracker()
    for i, line in enumerate(
        [
            "",
            "   ",
            "Loading safetensors checkpoint shards: 100% Completed | 4/4 [00:13<00:00,  3.28s/it]",
            "Capturing CUDA graphs (decode, FULL): 100%|██████████| 35/35 [00:02<00:00, 14.02it/s]",
            "(APIServer pid=1) INFO:     127.0.0.1:50000 - \"GET /health HTTP/1.1\" 200 OK",
            "(APIServer pid=1) INFO 09-23 05:11:40 [loggers.py:224] Engine 000: Avg prompt throughput: 0.0 tokens/s",
            "WARNING 09-23 05:11:40 [config.py:1] Something the parser does not know about",
        ]
    ):
        assert tr.feed(float(i), line) == []
    assert tr.phases == {}


def test_errors_are_collected():
    tr = PhaseTracker()
    tr.feed(1.0, "(EngineCore_DP0 pid=5) ERROR 09-23 05:11:00 [core.py:700] Traceback (most recent call last):")
    tr.feed(2.0, "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB")
    assert len(tr.errors) == 2
    assert tr.summary()["errors"][0].startswith("Traceback")


def test_harness_stamped_log_roundtrip():
    text = "\n".join(
        [
            "1000.000 # harness process_start gpu=0 label=main",
            "1013.270 (EngineCore_DP0 pid=2) INFO 09-23 05:10:36 [default_loader.py:385] Loading weights took 13.27 seconds",
            "1048.500 (EngineCore_DP0 pid=2) INFO 09-23 05:11:24 [core.py:295] init engine (profile, create kv cache, warmup model) took 47.83 s",
            "not-a-timestamp garbage line",
        ]
    )
    tr = parse_stamped_log(text)
    assert tr.t0 == 1000.0
    assert tr.offsets_ms()["weights_loaded"] == 13270.0
    assert tr.offsets_ms()["engine_init_done"] == 48500.0
