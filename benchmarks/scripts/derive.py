"""B3 derivation: raw/<run-id>/ -> derived/calibration.measured.json and derived/report.md.

    cd benchmarks && uv run python scripts/derive.py            # newest complete run of each type
    uv run python scripts/derive.py --run R1=R1-20260923T193249Z  # pin a run

Standard library only. The cost model mirrors src/engine/cost/step.ts (02 §6):

    step_ms = t_o + max(FLOPs / (η_c · peak), bytes / (η_b · BW))
    FLOPs   = 2 · params · (prefill tokens + decode seqs) + 4 · layers · hidden · attention pairs
    bytes   = weightBytes + kvBytesPerToken · (context read + tokens written)

Fits:
- η_b and t_o (R2): least squares of median inter-token latency on step bytes, over the decode
  points that are memory-bound at any plausible η_c (batch <= 8).
- η_c (R1): batch-1 TTFT = r + Σ chunk steps (chunks of maxNumBatchedTokens), with t_o and η_b
  from R2. r is the per-request API/tokenize/detokenize latency the step model doesn't contain
  (the simulator's router constant covers it). Relative least squares; r has a closed form
  for each η_c, η_c is a golden-section search.
- Split check (03 open item 3): the same fit with separate GEMM and attention efficiencies.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "raw"
DERIVED = ROOT / "derived"
PROVISIONAL = DERIVED / "calibration.json"
SPLIT_THRESHOLD = 0.15  # 03 open item 3


# ---------------------------------------------------------------------------- run discovery
def load_manifest(run_dir: Path) -> dict:
    return json.loads((run_dir / "manifest.json").read_text())


def find_runs(pins: dict[str, str]) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for rtype in [f"R{i}" for i in range(9)]:
        if rtype in pins:
            d = RAW / pins[rtype]
            if not (d / "manifest.json").exists():
                sys.exit(f"{d} has no manifest.json")
            out[rtype] = d
            continue
        cands = []
        for d in RAW.glob(f"{rtype}-*"):
            mp = d / "manifest.json"
            if not mp.exists():
                continue
            m = json.loads(mp.read_text())
            if m.get("status") != "complete" or m.get("run_type") != rtype:
                continue
            # R0 must have started both GPUs; the smoke run on GPU 0 alone doesn't count.
            if rtype == "R0" and len(m.get("servers", [])) < 2:
                continue
            cands.append((m["started_at"], d))
        if cands:
            out[rtype] = max(cands)[1]
    return out


def bench(run_dir: Path, point: dict) -> dict:
    return json.loads((run_dir / point["bench_file"]).read_text())


def points(m: dict, sweep: str | None = None) -> list[dict]:
    return [p for p in m.get("points", []) if not p.get("skipped") and (sweep is None or p.get("sweep") == sweep)]


# ---------------------------------------------------------------------------- cost model
class Model:
    def __init__(self, cal: dict):
        g, mo = cal["gpu"], cal["model"]
        self.peak = g["peakDenseFp16Flops"]
        self.bw = g["memoryBandwidthBytesPerSecond"]
        self.params = mo["params"]
        self.W = mo["weightBytes"]
        self.kv = mo["kvBytesPerToken"]
        self.attn_per_pair = 4 * mo["layers"] * mo["hiddenSize"]

    # Work of one step, split into GEMM FLOPs, attention FLOPs and bytes.
    def prefill_chunk(self, p: int, n: int) -> tuple[float, float, float]:
        pairs = n * p + n * (n + 1) / 2
        return 2 * self.params * n, self.attn_per_pair * pairs, self.W + self.kv * ((p + n) + n)

    def decode_step(self, b: int, ctx_sum: float) -> tuple[float, float, float]:
        return 2 * self.params * b, self.attn_per_pair * ctx_sum, self.W + self.kv * (ctx_sum + b)

    def step_ms(self, work, eta_g, eta_a, eta_b, t_o) -> float:
        gf, af, by = work
        compute = (gf / (eta_g * self.peak) + af / (eta_a * self.peak)) * 1e3
        memory = by / (eta_b * self.bw) * 1e3
        return t_o + max(compute, memory)

    def chunks(self, prompt: int, chunk: int, cached: int = 0) -> list[tuple[float, float, float]]:
        out, prior = [], min(cached, prompt - 1)
        while prior < prompt:
            n = min(chunk, prompt - prior)
            out.append(self.prefill_chunk(prior, n))
            prior += n
        return out


def golden(f, lo: float, hi: float, tol: float = 1e-6) -> float:
    g = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = f(c), f(d)
    while b - a > tol:
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = f(d)
    return (a + b) / 2


def linfit(xs: list[float], ys: list[float]) -> tuple[float, float, float]:
    """y = a + b·x by ordinary least squares; returns (a, b, r²)."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    b = sxy / sxx
    a = my - b * mx
    ss_res = sum((y - a - b * x) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - my) ** 2 for y in ys)
    return a, b, 1 - ss_res / ss_tot if ss_tot else 1.0


# ---------------------------------------------------------------------------- measurements
def median_itl_ms(b: dict) -> float:
    itls = [x for req in b["itls"] for x in req]
    return statistics.median(itls) * 1e3


def median_ttft_ms(b: dict, skip_first: bool = False) -> float:
    t = b["ttfts"][1:] if skip_first else b["ttfts"]
    return statistics.median(t) * 1e3


def r0_engine(m: dict) -> dict:
    rows = []
    for key, info in sorted(m["engine"]["info"].items()):
        r = info["resolved"]
        srv = next(s for s in m["servers"] if f"gpu{s['gpu']}-{s['label']}" == key)
        rows.append(
            {
                "gpu": info["gpu"],
                "block_size": r["cache_config"]["block_size"],
                "num_gpu_blocks": r["cache_config"]["num_gpu_blocks"],
                "kv_cache_tokens_logged": srv["values"].get("kv_cache_tokens"),
                "kv_cache_gib": srv["values"].get("kv_cache_gib"),
                "max_num_seqs": r["scheduler_config"]["max_num_seqs"],
                "max_num_batched_tokens": r["scheduler_config"]["max_num_batched_tokens"],
                "max_model_len": r["model_config"]["max_model_len"],
                "max_concurrency": srv["values"].get("max_concurrency"),
            }
        )
    return rows


def decode_points(m: dict, run_dir: Path) -> list[dict]:
    out = []
    for p in points(m):
        if p["sweep"] not in ("b1", "conc", "ctx_b1", "ctx_b8"):
            continue
        prm, b = p["params"], bench(run_dir, p)
        batch = prm["max_concurrency"]
        P, O = prm["input_len"], prm["output_len"]
        # Decode steps g = 1 .. O-1 attend to P + g tokens; mean P + O/2.
        ctx = P + O / 2
        out.append(
            {
                "id": p["id"],
                "sweep": p["sweep"],
                "batch": batch,
                "input_len": P,
                "output_len": O,
                "ctx": ctx,
                "itl_ms": median_itl_ms(b),
                "tpot_mean_ms": b.get("mean_tpot_ms"),
                "power": p.get("power"),
            }
        )
    return out


def prefill_points(m: dict, run_dir: Path) -> list[dict]:
    out = []
    for p in points(m, "ttft"):
        b = bench(run_dir, p)
        out.append(
            {
                "id": p["id"],
                "prompt": p["params"]["input_len"],
                "n": len(b["ttfts"]),
                "ttft_ms": median_ttft_ms(b),
                "ttft_p90_ms": b.get("p90_ttft_ms"),
                "power": p.get("power"),
            }
        )
    return out


# ---------------------------------------------------------------------------- fits
def fit_decode(model: Model, pts: list[dict]):
    use = [p for p in pts if p["batch"] <= 8]
    xs = [model.decode_step(p["batch"], p["batch"] * p["ctx"])[2] for p in use]
    ys = [p["itl_ms"] for p in use]
    a, slope, r2 = linfit(xs, ys)  # ms = t_o + bytes · slope
    eta_b = 1e3 / (slope * model.bw)
    return {"t_o": a, "eta_b": eta_b, "r2": r2, "n": len(use)}


def fit_prefill(model: Model, pts, chunk, eta_b, t_o, split: bool):
    work = [model.chunks(p["prompt"], chunk) for p in pts]
    meas = [p["ttft_ms"] for p in pts]

    def sums(eg, ea):
        return [sum(model.step_ms(w, eg, ea, eta_b, t_o) for w in ws) for ws in work]

    def best_r(S):
        num = sum((m - s) / m**2 for m, s in zip(meas, S))
        den = sum(1 / m**2 for m in meas)
        return max(0.0, num / den)

    def loss(S, r):
        return sum(((r + s - m) / m) ** 2 for s, m in zip(S, meas))

    def total(eg, ea):
        S = sums(eg, ea)
        return loss(S, best_r(S))

    if not split:
        e = golden(lambda x: total(x, x), 0.02, 1.0)
        eg = ea = e
    else:
        # Coarse grid, then alternate golden searches.
        grid = [0.05 * i for i in range(1, 21)]
        _, eg, ea = min((total(g, a), g, a) for g in grid for a in grid)
        for _ in range(6):
            eg = golden(lambda x: total(x, ea), 0.02, 1.0)
            ea = golden(lambda x: total(eg, x), 0.02, 1.0)
    S = sums(eg, ea)
    r = best_r(S)
    return {"eta_g": eg, "eta_a": ea, "r": r, "pred": [r + s for s in S], "pred_no_r": S, "rms_rel": math.sqrt(loss(S, r) / len(meas))}


def attn_share(model: Model, prompt: int, chunk: int) -> float:
    ws = model.chunks(prompt, chunk)
    g = sum(w[0] for w in ws)
    a = sum(w[1] for w in ws)
    return a / (g + a)


# ---------------------------------------------------------------------------- report helpers
def pct(x: float) -> str:
    return f"{x * 100:+.1f}%"


def fmt(x: float, nd: int = 1) -> str:
    return f"{x:,.{nd}f}"


def power_note(pw: dict | None) -> str:
    if not pw:
        return ""
    keys = [k for k in pw if "power_cap" in k or "limited" in k or "frac" in k]
    for k in keys:
        v = pw[k]
        if isinstance(v, (int, float)):
            return f"{v * 100:.0f}%" if v <= 1 else f"{v}"
    return ""


# ---------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", action="append", default=[], metavar="RTYPE=RUN_ID", help="pin a run, e.g. R1=R1-20260923T193249Z")
    ap.add_argument("--out", default=str(DERIVED), help="output directory (default derived/)")
    args = ap.parse_args()
    pins = dict(s.split("=", 1) for s in args.run)
    runs = find_runs(pins)
    for need in ("R0", "R1", "R2"):
        if need not in runs:
            sys.exit(f"no complete {need} run under raw/")
    man = {k: load_manifest(v) for k, v in runs.items()}
    prov = json.loads(PROVISIONAL.read_text())
    model = Model(prov)

    # R0: engine constants.
    eng_rows = r0_engine(man["R0"])
    bs = {r["block_size"] for r in eng_rows}
    mns = {r["max_num_seqs"] for r in eng_rows}
    mnbt = {r["max_num_batched_tokens"] for r in eng_rows}
    mml = {r["max_model_len"] for r in eng_rows}
    if len(bs) != 1 or len(mns) != 1 or len(mnbt) != 1 or len(mml) != 1:
        sys.exit(f"R0 GPUs disagree on engine limits: {eng_rows}")
    block = bs.pop()
    pool_raw = min(r["num_gpu_blocks"] * r["block_size"] for r in eng_rows)
    engine = {
        "kvPoolTokens": (pool_raw // block) * block,
        "blockSize": block,
        "maxNumSeqs": mns.pop(),
        "maxNumBatchedTokens": mnbt.pop(),
        "maxModelLen": mml.pop(),
    }
    chunk = engine["maxNumBatchedTokens"]

    # R2: η_b, t_o.
    dpts = decode_points(man["R2"], runs["R2"])
    dfit = fit_decode(model, dpts)
    eta_b, t_o = dfit["eta_b"], dfit["t_o"]

    # R1: η_c (single) and the split check.
    ppts = prefill_points(man["R1"], runs["R1"])
    single = fit_prefill(model, ppts, chunk, eta_b, t_o, split=False)
    split = fit_prefill(model, ppts, chunk, eta_b, t_o, split=True)
    eta_c = single["eta_g"]

    # Decode check across the whole R2 sweep with the fitted numbers.
    for p in dpts:
        w = model.decode_step(p["batch"], p["batch"] * p["ctx"])
        p["pred_ms"] = model.step_ms(w, eta_c, eta_c, eta_b, t_o)
        p["compute_ms"] = (w[0] + w[1]) / (eta_c * model.peak) * 1e3
        p["memory_ms"] = w[2] / (eta_b * model.bw) * 1e3

    # R6: prefix cache.
    prefix = dict(prov["prefixCache"])
    r6_rows = []
    if "R6" in runs:
        m6 = man["R6"]
        warm = {p["params"].get("prefix_len"): p for p in points(m6, "warm")}
        cold = {p["params"]["input_len"]: p for p in points(m6, "cold")}
        for plen, wp in sorted(warm.items()):
            suffix = wp["params"]["input_len"]
            cp = cold.get(plen + suffix)
            wb = bench(runs["R6"], wp)
            row = {
                "prefix": plen,
                "suffix": suffix,
                "warm_ms": median_ttft_ms(wb, skip_first=True),
                "fill_ms": wb["ttfts"][0] * 1e3,
                "cold_ms": median_ttft_ms(bench(runs["R6"], cp)) if cp else None,
            }
            total = plen + suffix
            row["pred_warm_ms"] = single["r"] + sum(model.step_ms(w, eta_c, eta_c, eta_b, t_o) for w in model.chunks(total, chunk, cached=plen))
            row["pred_cold_ms"] = single["r"] + sum(model.step_ms(w, eta_c, eta_c, eta_b, t_o) for w in model.chunks(total, chunk))
            r6_rows.append(row)
        mix = {p["id"]: p for p in points(m6, "mix")}
        ref = next((r for r in r6_rows if r["prefix"] == 8192), r6_rows[-1] if r6_rows else None)
        if ref and ref["cold_ms"]:
            prefix = {"warmTtftMs": round(ref["warm_ms"], 1), "coldTtftMs": round(ref["cold_ms"], 1), "prefixTokens": ref["prefix"]}
    else:
        mix = {}

    # R7: cold start.
    cold_start = json.loads(json.dumps(prov["coldStartMs"]))
    cold_src = {k: "provisional (not measured)" for k in cold_start}
    r7_rows = []
    if "R7" in runs:
        r7_rows = man["R7"].get("cold_start") or []
        names = {"process_restart": "processRestart", "host_reboot": "hostReboot", "replacement_host": "replacementHost"}
        for cond, key in names.items():
            rows = [r for r in r7_rows if r["condition"] == cond and r.get("weights_loaded_ms") and r.get("health_ok_ms")]
            if rows:
                cold_start[key] = {
                    "weightsLoaded": round(statistics.median(r["weights_loaded_ms"] for r in rows)),
                    "engineReady": round(statistics.median(r["health_ok_ms"] for r in rows)),
                }
                cold_src[key] = f"R7 median of {len(rows)} starts ({runs['R7'].name})"

    used = [runs[k].name for k in sorted(runs) if k in ("R0", "R1", "R2", "R6", "R7")]
    cal = {
        "schemaVersion": 1,
        "status": "measured",
        "source": {**prov["source"], "runIds": used},
        "gpu": prov["gpu"],
        "model": prov["model"],
        "engine": engine,
        "costModel": {
            "computeEfficiency": round(eta_c, 4),
            "bandwidthEfficiency": round(eta_b, 4),
            "stepOverheadMs": round(t_o, 3),
        },
        "coldStartMs": cold_start,
        "prefixCache": prefix,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "calibration.measured.json").write_text(json.dumps(cal, indent=2) + "\n")

    # ------------------------------------------------------------------ report
    L: list[str] = []
    w = L.append
    w("# Calibration fit report (B3)")
    w("")
    w("Generated by `scripts/derive.py` from the raw runs below. Rerun it to reproduce this file and")
    w("`calibration.measured.json`. Model: 02 §6 and `src/engine/cost/step.ts`.")
    w("")
    w("| Run | Directory | Used for |")
    w("|---|---|---|")
    feeds = {"R0": "engine constants", "R1": "η_c", "R2": "η_b, t_o; decode check", "R6": "prefix cache", "R7": "cold start"}
    for k in sorted(runs):
        if k in feeds:
            w(f"| {k} | `raw/{runs[k].name}` | {feeds[k]} |")
    w("")
    w("## Result")
    w("")
    w("| Field | Provisional | Measured | Source |")
    w("|---|---|---|---|")
    pc, pe = prov["costModel"], prov["engine"]
    w(f"| η_c `computeEfficiency` | {pc['computeEfficiency']} | {cal['costModel']['computeEfficiency']} | R1 fit |")
    w(f"| η_b `bandwidthEfficiency` | {pc['bandwidthEfficiency']} | {cal['costModel']['bandwidthEfficiency']} | R2 fit |")
    w(f"| t_o `stepOverheadMs` | {pc['stepOverheadMs']} | {cal['costModel']['stepOverheadMs']} | R2 fit |")
    for k in ("kvPoolTokens", "blockSize", "maxNumSeqs", "maxNumBatchedTokens", "maxModelLen"):
        w(f"| `engine.{k}` | {pe[k]:,} | {engine[k]:,} | R0 |")
    for k, v in cold_start.items():
        pv = prov["coldStartMs"][k]
        w(f"| `coldStartMs.{k}` | {pv['weightsLoaded']:,} / {pv['engineReady']:,} | {v['weightsLoaded']:,} / {v['engineReady']:,} | {cold_src[k]} |")
    w(f"| `prefixCache` warm / cold / prefix | null | {prefix['warmTtftMs']} / {prefix['coldTtftMs']} / {prefix['prefixTokens']} | R6 |")
    w("")
    w("Cold start is weights loaded / engine ready, in ms from process spawn. Engine ready is the")
    w("first `/health` 200.")
    w("")
    w("Per-request overhead r, which the step model doesn't include, fitted from R1:")
    w(f"**{single['r']:.1f} ms**. It covers HTTP, tokenization, scheduling latency and streaming the")
    w("first token. The simulator's fixed router constant is where it belongs (03 §4).")
    w("")

    w("## Conditions")
    w("")
    w("- The 250 W power cap held for most samples of every calibration point: up to 93% in R1, 50–92% in")
    w("  R2 (batch-1 decode included), with mean SM clocks of 850–1,050 MHz during R1. η_c and η_b therefore")
    w("  describe this capped card, as 02 §6 intends.")
    w("- An idle process held about 425 MiB on each GPU at 0% utilization throughout (manifest `operator_notes`).")
    w("- t_o came out at 0.7 ms against the provisional 4 ms. vLLM 0.20.1 runs async scheduling and CUDA")
    w("  graphs, so CPU work overlaps the GPU. The per-request cost lives in r instead.")
    w(f"- max_num_batched_tokens is {engine['maxNumBatchedTokens']:,}, not the provisional 8,192, so long prompts prefill in")
    w(f"  {engine['maxNumBatchedTokens']:,}-token chunks.")
    w("")
    w("## R0: engine constants")
    w("")
    w("| GPU | Blocks | Block size | KV tokens | KV GiB | max_num_seqs | max_num_batched_tokens | Max concurrency at 131k |")
    w("|---|---|---|---|---|---|---|---|")
    for r in eng_rows:
        w(f"| {r['gpu']} | {r['num_gpu_blocks']:,} | {r['block_size']} | {r['num_gpu_blocks'] * r['block_size']:,} | {r['kv_cache_gib']} | {r['max_num_seqs']} | {r['max_num_batched_tokens']:,} | {r['max_concurrency']} |")
    w("")
    w(f"`kvPoolTokens` is the smaller GPU's blocks × block size: {engine['kvPoolTokens']:,}.")
    for d in sorted(RAW.glob("R0-*")):
        if d == runs["R0"] or not (d / "manifest.json").exists():
            continue
        for srv in load_manifest(d).get("servers", []):
            if srv.get("compile_cache") == "miss" and srv.get("values", {}).get("kv_cache_tokens"):
                t = srv["values"]["kv_cache_tokens"]
                w(f"In `raw/{d.name}` the compile cache missed (a first start), and GPU {srv['gpu']} got {t:,} tokens:")
                w(f"{(1 - t / engine['kvPoolTokens']) * 100:.1f}% less. A replacement host (cold compile cache) may start with the smaller pool;")
                w("R7's replacement-host starts will show it.")
    w("")

    w("## R2: η_b and t_o")
    w("")
    w(f"Least squares of median inter-token latency on step bytes, over the {dfit['n']} decode points")
    w("at batch ≤ 8, where compute is far below memory time at any η_c. Slope gives η_b, intercept t_o.")
    w(f"r² = {dfit['r2']:.4f}. η_b = **{eta_b:.4f}** ({eta_b * model.bw / 1e9:,.0f} GB/s achieved),")
    w(f"t_o = **{t_o:.3f} ms**.")
    w("")
    w("Decode check across R2 with the fitted η_c, η_b and t_o. Context is the mean over the")
    w("output (input + output/2). Residual = predicted ÷ measured − 1.")
    w("")
    w("| Point | Batch | Context | Measured ITL p50 ms | Predicted ms | Residual | Bound | In fit |")
    w("|---|---|---|---|---|---|---|---|")
    for p in dpts:
        bound = "compute" if p["compute_ms"] > p["memory_ms"] else "memory"
        w(f"| {p['id']} | {p['batch']} | {p['ctx']:,.0f} | {p['itl_ms']:.2f} | {p['pred_ms']:.2f} | {pct(p['pred_ms'] / p['itl_ms'] - 1)} | {bound} | {'yes' if p['batch'] <= 8 else 'no'} |")
    w("")
    conc = [p for p in dpts if p["sweep"] == "conc"]
    big = [p for p in conc if p["batch"] >= 16]
    if big:
        worst_d = min(big, key=lambda p: p["pred_ms"] / p["itl_ms"])
        k_a, k_b, k_r2 = linfit([p["batch"] for p in big], [p["itl_ms"] for p in big])
        w("### Decode at large batch")
        w("")
        w(f"The model is within ~1% wherever it was fitted, but it underpredicts decode at batch ≥ 32:")
        w(f"by {abs(worst_d['pred_ms'] / worst_d['itl_ms'] - 1) * 100:.0f}% at batch {worst_d['batch']}. Measured ITL grows almost linearly with batch")
        w(f"from 16 to 256: {k_a:.2f} ms + {k_b * 1e3:.0f} µs per sequence (r² {k_r2:.3f}). The roofline instead stays")
        cross = next((q["batch"] for q in conc if q["compute_ms"] > q["memory_ms"]), None)
        w(f"flat on the weight read until compute crosses it{f' at batch {cross}' if cross else ''}. Two readings, both outside schema v1:")
        w("")
        w("- Small-M GEMMs run well below prefill efficiency. Implied decode η_c = FLOPs ÷ ((ITL − t_o) × peak),")
        w("  shown where decode could be compute-bound (batch ≥ 128):")
        w("")
        w("  | Batch | Implied decode η_c |")
        w("  |---|---|")
        for p in [q for q in big if q["batch"] >= 128]:
            fl = sum(model.decode_step(p["batch"], p["batch"] * p["ctx"])[:2])
            w(f"  | {p['batch']} | {fl / ((p['itl_ms'] - t_o) / 1e3 * model.peak):.3f} |")
        w("")
        w(f"- Or a per-sequence cost (sampling, scheduler and input prep, KV gather) of about {k_b * 1e3:.0f} µs per sequence per step,")
        w("  which the roofline has no term for.")
        w("")
        w("Consequence: at high batch the simulator's replica is faster than the real one, so the simulated")
        w("saturation knee (tab 2) lands at a higher rate than R3's. B4 should compare them. A per-sequence")
        w("step term would be a schema change for the integrator.")
        w("")

    w("## R1: η_c")
    w("")
    w(f"Batch-1 TTFT = r + Σ chunk steps, with chunks of {chunk:,} tokens (max_num_batched_tokens),")
    w("t_o and η_b from R2. Relative least squares over all R1 points.")
    w(f"Single η_c = **{eta_c:.4f}**, r = {single['r']:.1f} ms, RMS relative residual {single['rms_rel'] * 100:.1f}%.")
    w("")
    w("\"No r\" is Σ chunk steps alone, which is what `batch1TtftMs` in the simulator returns.")
    w(f"Without r, short prompts come out too fast ({pct(single['pred_no_r'][0] / ppts[0]['ttft_ms'] - 1)} at {ppts[0]['prompt']:,} tokens). The simulator needs a")
    w(f"per-request constant of about {single['r']:.0f} ms to match short-prompt TTFT.")
    w("")
    w("| Prompt | n | Measured TTFT p50 ms | Predicted ms | Residual | No r: residual | Split fit: residual | Attention share of FLOPs |")
    w("|---|---|---|---|---|---|---|---|")
    for i, p in enumerate(ppts):
        m = p["ttft_ms"]
        w(f"| {p['prompt']:,} | {p['n']} | {fmt(m)} | {fmt(single['pred'][i])} | {pct(single['pred'][i] / m - 1)} | {pct(single['pred_no_r'][i] / m - 1)} | {pct(split['pred'][i] / m - 1)} | {attn_share(model, p['prompt'], chunk) * 100:.0f}% |")
    w("")

    # Split check (03 open item 3).
    res = [single["pred"][i] / p["ttft_ms"] - 1 for i, p in enumerate(ppts)]
    # "Either end": the low end is where compute sets the step (skip the memory-bound tiny prompts,
    # whose TTFT is r + one memory-bound step and says nothing about η_c).
    cb = [i for i, p in enumerate(ppts) if model.step_ms(model.chunks(p["prompt"], chunk)[0], eta_c, eta_c, eta_b, 0) > model.W / (eta_b * model.bw) * 1e3 * 1.05]
    lo_i = cb[0] if cb else 0
    hi_i = len(ppts) - 1
    worst = max(abs(x) for x in res)
    need_split = abs(res[lo_i]) > SPLIT_THRESHOLD or abs(res[hi_i]) > SPLIT_THRESHOLD
    w("### η_c split check (03 open item 3)")
    w("")
    w(f"- Low end (smallest compute-bound prompt, {ppts[lo_i]['prompt']:,} tokens): residual {pct(res[lo_i])}.")
    w(f"- High end ({ppts[hi_i]['prompt']:,} tokens, attention {attn_share(model, ppts[hi_i]['prompt'], chunk) * 100:.0f}% of FLOPs): residual {pct(res[hi_i])}.")
    w(f"- Largest residual anywhere in R1: {worst * 100:.1f}%.")
    w(f"- Split fit: η_GEMM = {split['eta_g']:.4f}, η_attention = {split['eta_a']:.4f}, r = {split['r']:.1f} ms, RMS {split['rms_rel'] * 100:.1f}% (single: {single['rms_rel'] * 100:.1f}%).")
    w("")
    if need_split:
        w(f"**Verdict: split.** A single η_c misses by more than {SPLIT_THRESHOLD * 100:.0f}% at an end of R1's range. 03 open item 3 calls for")
        w("separate GEMM and attention efficiencies (calibration schema v2). That is a contract change for the integrator;")
        w("`calibration.measured.json` stays on schema v1 with the single η_c.")
    else:
        w(f"**Verdict: keep one η_c.** Both ends are within {SPLIT_THRESHOLD * 100:.0f}%, so schema v1 stands.")
    w("")

    if r6_rows:
        w("## R6: prefix cache")
        w("")
        w("Warm: shared prefix plus a new suffix at batch 1; the median excludes request 0, which fills the")
        w("cache. Cold: the same total length, nothing shared. Predictions use the fitted model with r.")
        w("")
        w("| Prefix | Suffix | Fill ms | Warm p50 ms | Cold p50 ms | Warm ÷ cold | Predicted warm | Predicted cold |")
        w("|---|---|---|---|---|---|---|---|")
        for r in r6_rows:
            ratio = f"{r['warm_ms'] / r['cold_ms']:.2f}" if r["cold_ms"] else "—"
            cold_s = fmt(r["cold_ms"]) if r["cold_ms"] else "—"
            w(f"| {r['prefix']:,} | {r['suffix']} | {fmt(r['fill_ms'])} | {fmt(r['warm_ms'])} | {cold_s} | {ratio} | {fmt(r['pred_warm_ms'])} | {fmt(r['pred_cold_ms'])} |")
        w("")
        if len(r6_rows) >= 2:
            ea, eb, er2 = linfit([r["prefix"] for r in r6_rows], [r["warm_ms"] - r["pred_warm_ms"] for r in r6_rows])
            w(f"Cold TTFT matches the model (it is R1's fit). Warm TTFT does not: the excess over the model")
            w(f"grows with the cached prefix at **{eb * 1e3:.1f} µs per cached token** (r² {er2:.3f}), which is")
            w(f"{eb * r6_rows[-1]['prefix']:.0f} ms at a {r6_rows[-1]['prefix']:,}-token prefix. The step model charges a cache hit nothing")
            w("beyond the suffix's attention to it. Likely sources: the API server tokenizing the whole prompt, and")
            w("the scheduler hashing and looking up its blocks. The lesson (a cache hit is far cheaper) holds, since")
            w("warm is 5–40% of cold, but simulated warm TTFT is optimistic at long prefixes. Candidate term for B4:")
            w("a per-prompt-token cost outside the GPU step.")
            w("")
        if mix:
            w("Under load (8 concurrent, 4k prefix + 256 suffix, 64 out):")
            w("")
            w("| Point | TTFT p50 ms | TTFT p99 ms | Output tok/s |")
            w("|---|---|---|---|")
            for pid, p in mix.items():
                s = p.get("summary") or {}
                w(f"| {pid} | {fmt(s.get('median_ttft_ms', float('nan')))} | {fmt(s.get('p99_ttft_ms', float('nan')))} | {fmt(s.get('output_throughput', float('nan')), 0)} |")
            w("")
        w(f"`prefixCache` in the calibration uses the {prefix['prefixTokens']:,}-token prefix row.")
        w("")

    w("## R7: cold start")
    w("")
    if r7_rows:
        w("| Condition | Trial | Weights loaded ms | Engine ready (/health) ms | First token ms | Compile cache |")
        w("|---|---|---|---|---|---|")
        for r in r7_rows:
            w(f"| {r['condition']} | {r['trial']} | {r['weights_loaded_ms']:,.0f} | {r['health_ok_ms']:,.0f} | {r['first_token_ms']:,.0f} | {r['compile_cache']} |")
        w("")
    for cond in sorted({r["condition"] for r in r7_rows}):
        rows = [r for r in r7_rows if r["condition"] == cond and r.get("health_ok_ms")]
        med = statistics.median(r["health_ok_ms"] for r in rows)
        for r in rows:
            if r["health_ok_ms"] > 2 * med:
                w(f"- {cond} trial {r['trial']} is an outlier ({r['health_ok_ms'] / 1e3:.0f} s against a median of {med / 1e3:.0f} s); see its manifest")
                w("  `operator_notes`. The median excludes it.")
    for k, s in cold_src.items():
        if s.startswith("provisional"):
            w(f"- `{k}`: **not measured**; the provisional value is carried unchanged. It needs `sudo` (see `RUNS.md`).")
    w("")
    (out / "report.md").write_text("\n".join(L) + "\n")
    print(json.dumps(cal["costModel"]), json.dumps(engine))
    print(f"wrote {out / 'calibration.measured.json'} and {out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
