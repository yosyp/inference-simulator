"""Benchmark harness for the Inference Simulator calibration runs (docs/03-benchmarks.md)."""

from pathlib import Path

__version__ = "0.1.0"

# benchmarks/ (this file is benchmarks/scripts/harness/__init__.py)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = PROJECT_ROOT / "runs"
RAW_DIR = PROJECT_ROOT / "raw"
