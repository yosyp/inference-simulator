"""Start, watch, and stop one `vllm serve` process pinned to a GPU and its NUMA node."""

from __future__ import annotations

import collections
import json
import os
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .commands import Command
from .phases import PhaseTracker

_SPLIT = re.compile(rb"[\r\n]")


class ServerError(RuntimeError):
    pass


class VllmServer:
    def __init__(self, gpu: int, command: Command, raw_log: Path, label: str, model: str):
        self.gpu, self.command, self.raw_log, self.label, self.model = gpu, command, raw_log, label, model
        self.tracker = PhaseTracker()
        self.tail: collections.deque[str] = collections.deque(maxlen=60)
        self.proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._log = None
        self._log_lock = threading.Lock()
        self.exit_code: int | None = None
        self.first_request: dict = {}

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self.raw_log.parent.mkdir(parents=True, exist_ok=True)
        self._log = open(self.raw_log, "w", buffering=1)
        t0 = time.time()
        self.tracker.mark("process_start", t0)
        self._write(t0, f"# harness process_start gpu={self.gpu} label={self.label}")
        self.proc = subprocess.Popen(
            list(self.command.argv),
            env=self.command.full_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # own process group, so stop() reaches the engine-core child
            bufsize=0,
        )
        self._reader = threading.Thread(target=self._read, daemon=True, name=f"vllm-log-gpu{self.gpu}")
        self._reader.start()

    def _write(self, ts: float, line: str) -> None:
        with self._log_lock:
            if self._log and not self._log.closed:
                self._log.write(f"{ts:.3f} {line}\n")

    def _read(self) -> None:
        assert self.proc and self.proc.stdout
        fd = self.proc.stdout.fileno()
        buf = b""
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            parts = _SPLIT.split(buf)
            buf = parts.pop()
            ts = time.time()
            for p in parts:
                self._line(ts, p)
        if buf:
            self._line(time.time(), buf)

    def _line(self, ts: float, raw: bytes) -> None:
        line = raw.decode("utf-8", "replace")
        if not line.strip():
            return
        self._write(ts, line)
        self.tail.append(line)
        self.tracker.feed(ts, line)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def wait_ready(self, health_url: str, timeout_s: float) -> float:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if not self.alive():
                raise ServerError(f"vLLM on GPU {self.gpu} exited during startup (code {self.proc.poll()}):\n" + "\n".join(list(self.tail)[-25:]))
            try:
                with urllib.request.urlopen(health_url, timeout=2) as r:
                    if r.status == 200:
                        t = time.time()
                        self.tracker.mark("health_ok", t)
                        return t
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.25)
        raise ServerError(f"vLLM on GPU {self.gpu} not ready after {timeout_s:g} s")

    def send_first_request(self, completions_url: str, input_len: int, output_len: int) -> dict:
        """One streamed completion right after ready; times the first token (03 §6 R7)."""
        # Roughly input_len tokens of plain text; the exact count does not matter here.
        words = f"first request after start {self.label} on gpu {self.gpu}. ".split()
        prompt = " ".join(words[i % len(words)] for i in range(max(1, int(input_len * 0.75))))
        body = json.dumps(
            {
                "model": self.model,
                "prompt": prompt,
                "max_tokens": output_len,
                "stream": True,
                "ignore_eos": True,
                "temperature": 0,
                "stream_options": {"include_usage": True},
            }
        ).encode()
        req = urllib.request.Request(completions_url, data=body, headers={"Content-Type": "application/json"})
        sent = time.time()
        self.tracker.mark("first_request_sent", sent)
        usage = None
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if msg.get("choices") and msg["choices"][0].get("text") and "first_token" not in self.tracker.phases:
                    self.tracker.mark("first_token", time.time())
                if msg.get("usage"):
                    usage = msg["usage"]
        done = time.time()
        self.tracker.mark("first_request_done", done)
        ft = self.tracker.phases.get("first_token")
        self.first_request = {
            "ttft_ms": round((ft - sent) * 1000, 1) if ft else None,
            "e2e_ms": round((done - sent) * 1000, 1),
            "usage": usage,
        }
        return self.first_request

    def stop(self, timeout_s: float) -> int | None:
        if self.proc is None:
            return None
        if self.alive():
            self.tracker.mark("stop_sent", time.time())
            for sig, wait in ((signal.SIGINT, timeout_s), (signal.SIGTERM, 15.0), (signal.SIGKILL, 10.0)):
                try:
                    os.killpg(self.proc.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    self.proc.wait(wait)
                    break
                except subprocess.TimeoutExpired:
                    continue
        self.exit_code = self.proc.poll()
        self.tracker.mark("exited", time.time())
        if self._reader:
            self._reader.join(5)
        with self._log_lock:
            if self._log and not self._log.closed:
                self._log.close()
        return self.exit_code

    def summary(self) -> dict:
        s = self.tracker.summary()
        s.update({"gpu": self.gpu, "label": self.label, "exit_code": self.exit_code, "first_request": self.first_request})
        return s


def http_json(url: str, timeout: float = 30.0) -> dict | list | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def http_post(url: str, timeout: float = 30.0) -> int | None:
    req = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError):
        return None
