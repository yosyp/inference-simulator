"""Prometheus text parser: vLLM's /metrics in text 0.0.4 and OpenMetrics spellings."""

from __future__ import annotations

import math

from harness import prom
from conftest import FIXTURES

TEXT004 = (FIXTURES / "metrics_text004.txt").read_text()

# OpenMetrics declares the counter family without _total; samples keep it.
OPENMETRICS = """\
# HELP vllm:prefix_cache_hits Prefix cache hits, in terms of number of cached tokens.
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits_total{engine="0",model_name="m"} 128.0
vllm:prefix_cache_hits_created{engine="0",model_name="m"} 1.7586e+09
# TYPE vllm:num_preemptions counter
vllm:num_preemptions_total{engine="0",model_name="m"} 2.0
# EOF
"""

# An exporter that emits counters without the _total suffix.
BARE = """\
# TYPE vllm:prefix_cache_hits counter
vllm:prefix_cache_hits{engine="0"} 64
# TYPE vllm:num_preemptions counter
vllm:num_preemptions{engine="0"} 1
"""


def test_counter_with_total_suffix_found_by_either_name():
    fams = prom.parse(TEXT004)
    assert prom.scalar(fams, "vllm:prefix_cache_hits") == 0.0
    assert prom.scalar(fams, "vllm:prefix_cache_hits_total") == 0.0
    assert prom.scalar(fams, "vllm:prefix_cache_queries") == 245760.0
    assert prom.scalar(fams, "vllm:num_preemptions") == 7.0
    assert fams["vllm:prefix_cache_hits"].type == "counter"


def test_openmetrics_counter_family_without_total():
    fams = prom.parse(OPENMETRICS)
    assert prom.scalar(fams, "vllm:prefix_cache_hits") == 128.0
    assert prom.scalar(fams, "vllm:prefix_cache_hits_total") == 128.0
    assert prom.scalar(fams, "vllm:num_preemptions") == 2.0


def test_counter_without_total_suffix():
    fams = prom.parse(BARE)
    assert prom.scalar(fams, "vllm:prefix_cache_hits") == 64.0
    assert prom.scalar(fams, "vllm:prefix_cache_hits_total") == 64.0
    assert prom.scalar(fams, "vllm:num_preemptions_total") == 1.0


def test_created_samples_are_ignored():
    fams = prom.parse(TEXT004 + OPENMETRICS)
    assert not any(name.endswith("_created") for name in fams)
    # the counter value is not polluted by the creation timestamp
    assert prom.scalar(fams, "vllm:prefix_cache_queries") == 245760.0


def test_gauges():
    fams = prom.parse(TEXT004)
    assert prom.scalar(fams, "vllm:kv_cache_usage_perc") == 0.4213
    assert prom.scalar(fams, "vllm:num_requests_running") == 3.0
    assert prom.scalar(fams, "vllm:num_requests_waiting") == 0.0


def test_histogram_whose_name_ends_in_total_keeps_its_name():
    fams = prom.parse(TEXT004)
    assert "vllm:iteration_tokens_total" in fams
    h = prom.histogram(fams, "vllm:iteration_tokens_total")
    assert h["count"] == 42.0 and h["sum"] == 12345.0
    assert h["buckets"] == {"1.0": 5.0, "8.0": 30.0, "2048.0": 41.0, "+Inf": 42.0}
    e2e = prom.histogram(fams, "vllm:e2e_request_latency_seconds")
    assert e2e["count"] == 4.0 and e2e["sum"] == 9.5


def test_label_sets_are_summed():
    text = """\
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0"} 2
vllm:num_requests_running{engine="1"} 5
"""
    assert prom.scalar(prom.parse(text), "vllm:num_requests_running") == 7.0


def test_escaped_labels_special_values_timestamps_and_junk():
    text = """\
# TYPE x gauge
x{a="q\\"uote",b="c,d",c="back\\\\slash"} 1.5 1700000000000
y_nan NaN
y_inf +Inf
y_ninf -Inf
this line is not a sample
z{unterminated="oops} 3
w 12
"""
    fams = prom.parse(text)
    s = fams["x"].samples[0]
    assert s.labels == {"a": 'q"uote', "b": "c,d", "c": "back\\slash"}
    assert s.value == 1.5
    assert math.isnan(fams["y_nan"].samples[0].value)
    assert fams["y_inf"].samples[0].value == math.inf
    assert fams["y_ninf"].samples[0].value == -math.inf
    assert prom.scalar(fams, "w") == 12.0
    assert prom.scalar(fams, "missing") is None


def test_untyped_input_infers_counter_from_total():
    fams = prom.parse('vllm:num_preemptions_total{engine="0"} 5\n')
    assert prom.scalar(fams, "vllm:num_preemptions") == 5.0
    assert fams["vllm:num_preemptions"].type == "counter"


def test_compact_uses_canonical_names_and_keeps_info_labels():
    fams = prom.parse(TEXT004)
    out = prom.compact(
        fams,
        [
            "vllm:prefix_cache_hits",
            "vllm:num_preemptions_total",
            "vllm:kv_cache_usage_perc",
            "vllm:iteration_tokens_total",
            "vllm:cache_config_info",
            "vllm:not_there",
        ],
    )
    assert out["vllm:prefix_cache_hits"] == 0.0
    assert out["vllm:num_preemptions"] == 7.0
    assert out["vllm:kv_cache_usage_perc"] == 0.4213
    assert out["vllm:iteration_tokens_total"]["count"] == 42.0
    assert out["vllm:cache_config_info"][0]["block_size"] == "16"
    assert out["vllm:cache_config_info"][0]["num_gpu_blocks"] == "8981"
    assert "vllm:not_there" not in out
