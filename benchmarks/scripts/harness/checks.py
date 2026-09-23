"""Post-point and post-run checks that flag a run in its manifest.

The main one is 03 §5: `random` prompts are unique, so `vllm:prefix_cache_hits` must not
grow during R1 and R2. A hit means a calibration point reused cached KV and its TTFT is
too low.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

HITS = "vllm:prefix_cache_hits"
QUERIES = "vllm:prefix_cache_queries"
PREEMPTIONS = "vllm:num_preemptions"

# NVML clock-event reason bits (nvmlClocksEventReason*).
CLOCK_EVENT_BITS = {
    0x1: "gpu_idle",
    0x2: "applications_clocks_setting",
    0x4: "sw_power_cap",
    0x8: "hw_slowdown",
    0x10: "sync_boost",
    0x20: "sw_thermal_slowdown",
    0x40: "hw_thermal_slowdown",
    0x80: "hw_power_brake_slowdown",
    0x100: "display_clock_setting",
}


def decode_clock_events(mask: int | None) -> list[str]:
    if mask is None:
        return []
    return [name for bit, name in CLOCK_EVENT_BITS.items() if mask & bit]


@dataclass
class Flag:
    code: str
    severity: str  # "warning" | "error"
    message: str
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def counter_delta(before: float | None, after: float | None) -> float | None:
    """Delta of a monotonic counter. A decrease means the server restarted and the counter
    reset, so the delta is the value after the reset."""
    if before is None or after is None:
        return None
    if after < before:
        return after
    return after - before


@dataclass
class CounterWindow:
    """Counter readings scraped right before and right after one measurement point."""

    point_id: str
    gpu: int
    before: dict[str, float | None]
    after: dict[str, float | None]

    def delta(self, name: str) -> float | None:
        return counter_delta(self.before.get(name), self.after.get(name))


def check_prefix_cache_zero(windows: list[CounterWindow], run_id: str) -> list[Flag]:
    """Flag every point whose prefix-cache hit counter grew, or could not be read."""
    flags = []
    for w in windows:
        hits = w.delta(HITS)
        queries = w.delta(QUERIES)
        if hits is None:
            flags.append(
                Flag(
                    "prefix_cache_unverified",
                    "warning",
                    f"{run_id} {w.point_id}: could not read {HITS} before and after the point",
                    {"point": w.point_id, "gpu": w.gpu},
                )
            )
        elif hits > 0:
            flags.append(
                Flag(
                    "prefix_cache_hits_nonzero",
                    "error",
                    f"{run_id} {w.point_id}: prefix cache hit {hits:g} tokens; calibration prompts must be unique (03 §5)",
                    {
                        "point": w.point_id,
                        "gpu": w.gpu,
                        "hit_tokens": hits,
                        "query_tokens": queries,
                        "hit_rate": (hits / queries) if queries else None,
                    },
                )
            )
    return flags


def check_no_preemption(windows: list[CounterWindow], run_id: str) -> list[Flag]:
    flags = []
    for w in windows:
        d = w.delta(PREEMPTIONS)
        if d and d > 0:
            flags.append(
                Flag(
                    "unexpected_preemption",
                    "warning",
                    f"{run_id} {w.point_id}: {d:g} preemptions in a run that should stay below the KV ceiling",
                    {"point": w.point_id, "gpu": w.gpu, "preemptions": d},
                )
            )
    return flags


def check_bench_result(result: dict | None, run_id: str, point_id: str, expected: int) -> list[Flag]:
    if result is None:
        return [Flag("bench_missing", "error", f"{run_id} {point_id}: no bench result file", {"point": point_id})]
    completed = int(result.get("completed", 0) or 0)
    failed = int(result.get("failed", 0) or 0)
    if failed or completed < expected:
        return [
            Flag(
                "bench_failures",
                "error" if completed == 0 else "warning",
                f"{run_id} {point_id}: {completed}/{expected} requests completed, {failed} failed",
                {"point": point_id, "completed": completed, "failed": failed, "expected": expected},
            )
        ]
    return []


def power_cap_summary(nvml_records: list[dict], gpu: int, start: float, end: float) -> dict:
    """Share of 1 s NVML samples in [start, end] with a power-cap or thermal clock event,
    plus mean power and SM clock. B2 notes power-limited intervals from this."""
    rows = [r for r in nvml_records if r.get("gpu") == gpu and start <= r.get("t", 0) <= end]
    if not rows:
        return {"samples": 0}
    capped = sum(1 for r in rows if "sw_power_cap" in (r.get("clock_events") or []))
    thermal = sum(
        1 for r in rows if {"sw_thermal_slowdown", "hw_thermal_slowdown", "hw_slowdown"} & set(r.get("clock_events") or [])
    )
    powers = [r["power_w"] for r in rows if r.get("power_w") is not None]
    clocks = [r["sm_clock_mhz"] for r in rows if r.get("sm_clock_mhz") is not None]
    return {
        "samples": len(rows),
        "power_capped_fraction": round(capped / len(rows), 3),
        "thermal_fraction": round(thermal / len(rows), 3),
        "mean_power_w": round(sum(powers) / len(powers), 1) if powers else None,
        "mean_sm_clock_mhz": round(sum(clocks) / len(clocks), 1) if clocks else None,
    }


def windows_from_metrics(records: list[dict], points: list[dict]) -> list[CounterWindow]:
    """Rebuild counter windows for finished points from metrics.jsonl (for `check` on an
    existing run directory). Uses the last sample at or before the start and the first
    sample at or after the end."""
    out = []
    for p in points:
        gpu, start, end = p.get("gpu", 0), p.get("started_epoch_s"), p.get("ended_epoch_s")
        if start is None or end is None:
            continue
        rows = sorted((r for r in records if r.get("gpu") == gpu and r.get("ok")), key=lambda r: r["t"])
        before = [r for r in rows if r["t"] <= start]
        after = [r for r in rows if r["t"] >= end]
        b = before[-1]["m"] if before else {}
        a = after[0]["m"] if after else {}
        names = (HITS, QUERIES, PREEMPTIONS)
        out.append(CounterWindow(p["id"], gpu, {n: b.get(n) for n in names}, {n: a.get(n) for n in names}))
    return out
