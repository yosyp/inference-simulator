"""Length sampling for generated datasets (the tokenizer part needs the engine venv)."""

from __future__ import annotations

import statistics

from harness.datasets import main, sample_lognormal_lengths


def test_lognormal_lengths_are_deterministic_and_clipped():
    a = sample_lognormal_lengths(5000, 7, median=256, sigma=0.8, lo=16, hi=4096)
    b = sample_lognormal_lengths(5000, 7, median=256, sigma=0.8, lo=16, hi=4096)
    assert a == b
    assert min(a) >= 16 and max(a) <= 4096
    assert 230 < statistics.median(a) < 285


def test_different_seeds_differ():
    assert sample_lognormal_lengths(50, 1, 128, 0.6, 8, 768) != sample_lognormal_lengths(50, 2, 128, 0.6, 8, 768)


def test_cli_requires_distribution_flags(capsys):
    try:
        main(["--kind", "lognormal", "--model", "m", "--num-prompts", "3", "--seed", "1", "--out", "x.jsonl"])
    except SystemExit as e:
        assert e.code == 2
    else:
        raise AssertionError("expected argparse to reject missing flags")
