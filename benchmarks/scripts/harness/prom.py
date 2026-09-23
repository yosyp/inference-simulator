"""Tolerant parser for the Prometheus text exposition format served by vLLM's /metrics.

vLLM exposes metrics through prometheus_client. Depending on the client version and the
negotiated format, a counter family may be named ``vllm:prefix_cache_hits`` (OpenMetrics
``# TYPE`` line) while its sample is ``vllm:prefix_cache_hits_total``, or both may carry
``_total``. The harness therefore stores counters under a canonical name without ``_total``
and lets callers look them up by either spelling.

Histograms keep their family name as-is: ``vllm:iteration_tokens_total`` is a histogram
whose base name happens to end in ``_total``; its samples are ``..._bucket``, ``_sum`` and
``_count``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

_SAMPLE_RE = re.compile(
    r"""^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)
        (?:\{(?P<labels>.*)\})?
        \s+(?P<value>\S+)
        (?:\s+(?P<ts>-?\d+(?:\.\d+)?))?
        \s*$""",
    re.VERBOSE,
)
_LABEL_RE = re.compile(r'\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?')
_HIST_SUFFIXES = ("_bucket", "_sum", "_count")
_SUMMARY_SUFFIXES = ("_sum", "_count")


@dataclass(frozen=True)
class Sample:
    name: str
    labels: dict[str, str]
    value: float


@dataclass
class Family:
    """One metric family. ``name`` is canonical (counters without ``_total``)."""

    name: str
    type: str = "untyped"
    samples: list[Sample] = field(default_factory=list)


def _unescape(v: str) -> str:
    return v.replace(r"\\", "\x00").replace(r"\"", '"').replace(r"\n", "\n").replace("\x00", "\\")


def _parse_labels(text: str | None) -> dict[str, str]:
    if not text:
        return {}
    labels: dict[str, str] = {}
    pos = 0
    while pos < len(text):
        m = _LABEL_RE.match(text, pos)
        if not m:
            break
        labels[m.group(1)] = _unescape(m.group(2))
        pos = m.end()
    return labels


def _parse_value(v: str) -> float:
    lowered = v.lower()
    if lowered in ("nan",):
        return math.nan
    if lowered in ("+inf", "inf"):
        return math.inf
    if lowered == "-inf":
        return -math.inf
    return float(v)


def canonical_name(name: str) -> str:
    """Canonical key for lookups: strip a trailing ``_total`` (counter convention)."""
    return name[: -len("_total")] if name.endswith("_total") else name


def _family_for_sample(sample_name: str, types: dict[str, str]) -> tuple[str, str]:
    """Return (canonical family name, type) for a sample name."""
    # prometheus_client emits a `<counter>_created` timestamp next to each counter, in text
    # 0.0.4 even with its own `# TYPE ... gauge` line. It is never a metric we want.
    if sample_name.endswith("_created"):
        base = sample_name[: -len("_created")]
        if types.get(base) in ("counter", "histogram", "summary") or types.get(base + "_total") == "counter":
            return base + "_created", "created"
    # Exact TYPE match next (text format 0.0.4 declares counters with their _total name).
    if sample_name in types:
        t = types[sample_name]
        return (canonical_name(sample_name) if t == "counter" else sample_name), t
    for suffix in _HIST_SUFFIXES:
        if sample_name.endswith(suffix):
            base = sample_name[: -len(suffix)]
            t = types.get(base)
            if t in ("histogram", "summary", "gaugehistogram"):
                return base, t
    # OpenMetrics declares the counter family without _total.
    if sample_name.endswith("_total"):
        base = sample_name[: -len("_total")]
        if types.get(base) == "counter":
            return base, "counter"
    # Untyped input: infer from the suffix.
    if sample_name.endswith("_bucket"):
        return sample_name[: -len("_bucket")], "histogram"
    if sample_name.endswith("_total"):
        return canonical_name(sample_name), "counter"
    return sample_name, types.get(sample_name, "untyped")


def parse(text: str) -> dict[str, Family]:
    """Parse exposition text into families keyed by canonical name.

    Malformed lines are skipped rather than raising: a scrape taken while the server is
    shutting down must not kill the scraper.
    """
    types: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("# TYPE "):
            parts = line.split(None, 3)
            if len(parts) == 4:
                types[parts[2]] = parts[3].strip()

    families: dict[str, Family] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _SAMPLE_RE.match(line)
        if not m:
            continue
        try:
            value = _parse_value(m.group("value"))
        except ValueError:
            continue
        name = m.group("name")
        fam_name, fam_type = _family_for_sample(name, types)
        if fam_type == "created":
            continue  # creation timestamps are noise for our purposes
        fam = families.get(fam_name)
        if fam is None:
            fam = families[fam_name] = Family(name=fam_name, type=fam_type)
        fam.samples.append(Sample(name=name, labels=_parse_labels(m.group("labels")), value=value))
    return families


def lookup(families: dict[str, Family], name: str) -> Family | None:
    """Find a family by name, accepting counters with or without ``_total``."""
    for key in (name, canonical_name(name), name + "_total"):
        if key in families:
            return families[key]
    return None


def scalar(families: dict[str, Family], name: str) -> float | None:
    """Sum of a counter or gauge across label sets (one engine: usually one series)."""
    fam = lookup(families, name)
    if fam is None:
        return None
    vals = [
        s.value
        for s in fam.samples
        if not s.name.endswith(_HIST_SUFFIXES) or fam.type not in ("histogram", "summary")
    ]
    if not vals:
        return None
    return float(sum(vals))


def histogram(families: dict[str, Family], name: str) -> dict | None:
    """Aggregate a histogram across label sets into {sum, count, buckets{le: cumulative}}."""
    fam = lookup(families, name)
    if fam is None:
        return None
    out: dict = {"sum": 0.0, "count": 0.0, "buckets": {}}
    seen = False
    for s in fam.samples:
        if s.name.endswith("_bucket"):
            le = s.labels.get("le", "+Inf")
            out["buckets"][le] = out["buckets"].get(le, 0.0) + s.value
            seen = True
        elif s.name.endswith("_sum"):
            out["sum"] += s.value
            seen = True
        elif s.name.endswith("_count"):
            out["count"] += s.value
            seen = True
    return out if seen else None


def compact(families: dict[str, Family], wanted: list[str]) -> dict:
    """Reduce a scrape to the metrics we log: scalars for counters and gauges, and
    sum/count/buckets for histograms. Keys are canonical names; missing metrics are omitted.

    ``info``-style gauges (``*_info``) keep their labels, because the labels are the payload
    (``vllm:cache_config_info`` carries block_size and num_gpu_blocks).
    """
    out: dict = {}
    for want in wanted:
        fam = lookup(families, want)
        if fam is None:
            continue
        key = fam.name if fam.type != "counter" else canonical_name(fam.name)
        if fam.type in ("histogram", "summary"):
            out[key] = histogram(families, want)
        elif key.endswith("_info"):
            out[key] = [dict(s.labels) for s in fam.samples]
        else:
            out[key] = scalar(families, want)
    return out
