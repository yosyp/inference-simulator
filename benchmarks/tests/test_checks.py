"""Prefix-cache-hit check (03 §5) and the other run flags."""

from __future__ import annotations

from harness import prom
from harness.checks import (
    HITS,
    PREEMPTIONS,
    QUERIES,
    CounterWindow,
    check_bench_result,
    check_no_preemption,
    check_prefix_cache_zero,
    counter_delta,
    decode_clock_events,
    power_cap_summary,
    windows_from_metrics,
)


def scrape(hits: float, queries: float, preemptions: float = 0, total_suffix: bool = True) -> dict:
    """Counter readings the way the executor takes them: parse /metrics text, then scalar()."""
    sfx = "_total" if total_suffix else ""
    text = f"""\
# TYPE vllm:prefix_cache_hits{sfx} counter
vllm:prefix_cache_hits{sfx}{{engine="0"}} {hits}
# TYPE vllm:prefix_cache_queries{sfx} counter
vllm:prefix_cache_queries{sfx}{{engine="0"}} {queries}
# TYPE vllm:num_preemptions{sfx} counter
vllm:num_preemptions{sfx}{{engine="0"}} {preemptions}
"""
    fams = prom.parse(text)
    return {n: prom.scalar(fams, n) for n in (HITS, QUERIES, PREEMPTIONS)}


def test_counter_delta():
    assert counter_delta(10, 25) == 15
    assert counter_delta(10, 10) == 0
    assert counter_delta(100, 4) == 4  # server restarted, counter reset
    assert counter_delta(None, 4) is None
    assert counter_delta(4, None) is None


def test_zero_hits_passes_with_or_without_total_suffix():
    for total in (True, False):
        w = CounterWindow("in128", 0, scrape(0, 1000, total_suffix=total), scrape(0, 4840, total_suffix=total))
        assert check_prefix_cache_zero([w], "R1") == []


def test_nonzero_hits_flagged_with_rate():
    windows = [
        CounterWindow("in128", 0, scrape(0, 0), scrape(0, 3840)),
        CounterWindow("in256", 0, scrape(0, 3840), scrape(112, 11520)),
    ]
    flags = check_prefix_cache_zero(windows, "R1")
    assert len(flags) == 1
    f = flags[0]
    assert f.code == "prefix_cache_hits_nonzero" and f.severity == "error"
    assert f.detail["point"] == "in256" and f.detail["hit_tokens"] == 112
    assert abs(f.detail["hit_rate"] - 112 / 7680) < 1e-9


def test_hits_before_the_point_do_not_count():
    # 500 hits from an earlier point; nothing new during this one.
    w = CounterWindow("c064", 0, scrape(500, 9000), scrape(500, 40000))
    assert check_prefix_cache_zero([w], "R2") == []


def test_unreadable_metrics_are_flagged_unverified():
    w = CounterWindow("in128", 0, {HITS: None, QUERIES: None}, scrape(0, 10))
    flags = check_prefix_cache_zero([w], "R1")
    assert [f.code for f in flags] == ["prefix_cache_unverified"]


def test_counter_reset_mid_point_still_flags():
    w = CounterWindow("in128", 0, scrape(900, 9000), scrape(16, 100))
    flags = check_prefix_cache_zero([w], "R1")
    assert flags and flags[0].detail["hit_tokens"] == 16


def test_windows_from_metrics_jsonl():
    rows = [
        {"t": 100.0, "gpu": 0, "ok": True, "m": {HITS: 0.0, QUERIES: 0.0, PREEMPTIONS: 0.0}},
        {"t": 101.0, "gpu": 0, "ok": True, "m": {HITS: 0.0, QUERIES: 100.0, PREEMPTIONS: 0.0}},
        {"t": 102.0, "gpu": 0, "ok": False, "err": "URLError"},
        {"t": 103.0, "gpu": 0, "ok": True, "m": {HITS: 48.0, QUERIES: 400.0, PREEMPTIONS: 1.0}},
        {"t": 103.0, "gpu": 1, "ok": True, "m": {HITS: 999.0, QUERIES: 999.0, PREEMPTIONS: 9.0}},
    ]
    # before = last good sample at or before the start (t=101), after = first at or after the end (t=103)
    points = [{"id": "p", "gpu": 0, "started_epoch_s": 101.2, "ended_epoch_s": 102.5}]
    (w,) = windows_from_metrics(rows, points)
    assert w.delta(HITS) == 48.0 and w.delta(QUERIES) == 300.0 and w.delta(PREEMPTIONS) == 1.0
    assert check_prefix_cache_zero([w], "R2")[0].detail["hit_tokens"] == 48.0
    assert check_no_preemption([w], "R2")[0].code == "unexpected_preemption"


def test_bench_result_check():
    assert check_bench_result({"completed": 30, "failed": 0}, "R1", "in128", 30) == []
    (f,) = check_bench_result({"completed": 28, "failed": 2}, "R1", "in128", 30)
    assert f.code == "bench_failures" and f.severity == "warning"
    (f,) = check_bench_result({"completed": 0, "failed": 30}, "R1", "in128", 30)
    assert f.severity == "error"
    assert check_bench_result(None, "R1", "in128", 30)[0].code == "bench_missing"


def test_clock_events_and_power_summary():
    assert decode_clock_events(0x4) == ["sw_power_cap"]
    assert decode_clock_events(0x1 | 0x40) == ["gpu_idle", "hw_thermal_slowdown"]
    assert decode_clock_events(None) == []
    rows = [
        {"t": 10.0, "gpu": 0, "power_w": 249.0, "sm_clock_mhz": 1200, "clock_events": ["sw_power_cap"]},
        {"t": 11.0, "gpu": 0, "power_w": 247.0, "sm_clock_mhz": 1250, "clock_events": ["sw_power_cap"]},
        {"t": 12.0, "gpu": 0, "power_w": 180.0, "sm_clock_mhz": 1410, "clock_events": []},
        {"t": 12.0, "gpu": 1, "power_w": 40.0, "sm_clock_mhz": 210, "clock_events": ["gpu_idle"]},
        {"t": 20.0, "gpu": 0, "power_w": 250.0, "sm_clock_mhz": 1100, "clock_events": ["sw_power_cap"]},
    ]
    s = power_cap_summary(rows, 0, 10.0, 12.0)
    assert s["samples"] == 3 and s["power_capped_fraction"] == 0.667
    assert s["mean_power_w"] == 225.3 and s["thermal_fraction"] == 0.0
    assert power_cap_summary(rows, 0, 50.0, 60.0) == {"samples": 0}
