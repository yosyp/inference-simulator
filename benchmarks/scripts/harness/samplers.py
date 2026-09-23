"""Background samplers: NVML and vLLM /metrics, one JSONL line per GPU per second."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

from . import prom


class JsonlWriter:
    """Thread-safe line writer; several samplers may share one file (R8 scrapes two GPUs)."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._f = open(path, "a", buffering=1)
        self._lock = threading.Lock()
        self.path = path

    def write(self, record: dict) -> None:
        line = json.dumps(sanitize(record), separators=(",", ":"), allow_nan=False, default=_json_default)
        with self._lock:
            self._f.write(line + "\n")

    def close(self) -> None:
        with self._lock:
            if not self._f.closed:
                self._f.close()


def _json_default(o):
    return str(o)


def sanitize(o):
    """Replace NaN and +/-Inf (not valid JSON) with None, recursively."""
    if isinstance(o, float) and (o != o or o in (float("inf"), float("-inf"))):
        return None
    if isinstance(o, dict):
        return {k: sanitize(v) for k, v in o.items()}
    if isinstance(o, list):
        return [sanitize(v) for v in o]
    return o


class Periodic(threading.Thread):
    """Calls `tick()` every `interval` seconds on a fixed grid (no drift)."""

    def __init__(self, interval: float, tick: Callable[[float], None], name: str):
        super().__init__(daemon=True, name=name)
        self.interval = interval
        self._tick = tick
        self._stop_evt = threading.Event()
        self.errors = 0

    def run(self) -> None:
        start = time.monotonic()
        k = 0
        while not self._stop_evt.is_set():
            try:
                self._tick(time.time())
            except Exception:
                self.errors += 1
            k += 1
            delay = start + k * self.interval - time.monotonic()
            if delay < 0:  # fell behind; skip missed slots instead of bursting
                k += int(-delay // self.interval) + 1
                delay = start + k * self.interval - time.monotonic()
            self._stop_evt.wait(max(0.0, delay))

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_evt.set()
        self.join(timeout)


def fetch_metrics(url: str, timeout: float = 0.9) -> dict[str, prom.Family]:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return prom.parse(r.read().decode("utf-8", "replace"))


def scrape_record(url: str, gpu: int, wanted: tuple[str, ...], timeout: float = 0.9) -> dict:
    t = time.time()
    try:
        fams = fetch_metrics(url, timeout)
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"t": round(t, 3), "gpu": gpu, "ok": False, "err": type(e).__name__}
    return {"t": round(t, 3), "gpu": gpu, "ok": True, "m": sanitize(prom.compact(fams, list(wanted)))}


class MetricsScraper:
    def __init__(self, url: str, gpu: int, writer: JsonlWriter, wanted: tuple[str, ...], interval: float = 1.0):
        self.url, self.gpu, self.writer, self.wanted = url, gpu, writer, wanted
        self.samples = 0
        self.failures = 0
        self._thread = Periodic(interval, self._tick, name=f"metrics-gpu{gpu}")

    def _tick(self, _now: float) -> None:
        rec = scrape_record(self.url, self.gpu, self.wanted)
        self.samples += 1
        if not rec["ok"]:
            self.failures += 1
        self.writer.write(rec)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._thread.stop()


class NvmlSampler:
    def __init__(self, gpus: list[int], writer: JsonlWriter, interval: float = 1.0):
        from . import nvml

        self._nvml = nvml
        self.gpus, self.writer = gpus, writer
        self.samples = 0
        self._thread = Periodic(interval, self._tick, name="nvml")

    def _tick(self, now: float) -> None:
        for g in self.gpus:
            rec = {"t": round(now, 3), **self._nvml.sample(g)}
            self.writer.write(rec)
        self.samples += 1

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._thread.stop()
