"""Test guards: no test may reach a GPU.

Importing pynvml, torch or vllm raises, CUDA devices are hidden, and the `no_processes`
fixture makes any attempt to spawn a process fail.
"""

from __future__ import annotations

import importlib.abc
import os
import subprocess
import sys
from pathlib import Path

import pytest

os.environ["CUDA_VISIBLE_DEVICES"] = ""
_BLOCKED = {"pynvml", "torch", "vllm"}


class _BlockGpuImports(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in _BLOCKED:
            raise ImportError(f"tests must not import {name}: it could touch the GPU")
        return None


sys.meta_path.insert(0, _BlockGpuImports())

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def no_processes(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError(f"test tried to start a process: {args[0] if args else kwargs}")

    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(os, "system", refuse)
