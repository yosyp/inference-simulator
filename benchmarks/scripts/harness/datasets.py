"""Generate custom JSONL datasets for `vllm bench serve --dataset-name custom`.

Two kinds:

- ``fixed``: every prompt has exactly ``--input-len`` tokens of uniformly random token ids.
  Unlike vLLM's ``random`` dataset (runs of consecutive ids from a random start), two prompts
  cannot coincide, so a zero-prefix-hit point stays at zero however many prompts it has.
- ``lognormal``: prompt and output lengths drawn from clipped lognormals (R3 knee, R5
  overload). ``output_tokens`` is written per row and bench runs with
  ``--custom-output-len -1 --ignore-eos``.

Lengths count the BOS token the server adds, so ``input_tokens`` matches what vLLM sees
and what bench reports. Runs on CPU; needs the tokenizer from the local Hugging Face cache.
Usage: ``python -m harness.datasets --kind fixed --model M --num-prompts N --seed S ...``
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path


def sample_lognormal_lengths(
    n: int, seed: int, median: float, sigma: float, lo: int, hi: int
) -> list[int]:
    rng = random.Random(seed)
    mu = math.log(median)
    return [min(hi, max(lo, int(round(rng.lognormvariate(mu, sigma))))) for _ in range(n)]


def sample_lengths(args: argparse.Namespace) -> list[tuple[int, int]]:
    if args.kind == "fixed":
        return [(args.input_len, args.output_len)] * args.num_prompts
    ins = sample_lognormal_lengths(args.num_prompts, args.seed, args.input_median, args.input_sigma, args.input_min, args.input_max)
    outs = sample_lognormal_lengths(
        args.num_prompts, args.seed + 7_919, args.output_median, args.output_sigma, args.output_min, args.output_max
    )
    return list(zip(ins, outs))


def _prompt_of_length(tokenizer, rng: random.Random, allowed: list[int], target: int, retries: int = 10) -> tuple[str, int]:
    """Random tokens -> text whose re-tokenization (without special tokens) has `target` tokens.
    Mirrors vLLM's gen_prompt_decode_to_target_len."""
    ids = [rng.choice(allowed) for _ in range(target)]
    text = tokenizer.decode(ids)
    for _ in range(retries):
        ids = tokenizer.encode(text, add_special_tokens=False)
        if len(ids) == target:
            break
        if len(ids) < target:
            ids += [rng.choice(allowed) for _ in range(target - len(ids))]
        else:
            ids = ids[:target]
        text = tokenizer.decode(ids)
    return text, len(tokenizer.encode(text, add_special_tokens=False))


def generate(args: argparse.Namespace) -> dict:
    from transformers import AutoTokenizer  # engine group only

    tok = AutoTokenizer.from_pretrained(args.model)
    special = set(tok.all_special_ids)
    allowed = [i for i in range(tok.vocab_size) if i not in special]
    n_special = tok.num_special_tokens_to_add()
    rng = random.Random(args.seed)
    rows, starts = [], set()
    for inp, out in sample_lengths(args):
        text, got = _prompt_of_length(tok, rng, allowed, max(1, inp - n_special))
        head = tuple(tok.encode(text, add_special_tokens=False)[:32])
        if head in starts:  # astronomically unlikely with random ids; fail loudly rather than hit the cache
            raise SystemExit("duplicate prompt prefix generated; change the seed")
        starts.add(head)
        rows.append({"prompt": text, "output_tokens": out, "input_tokens": got + n_special})
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    ins = [r["input_tokens"] for r in rows]
    outs = [r["output_tokens"] for r in rows]
    return {
        "rows": len(rows),
        "input_tokens_mean": sum(ins) / len(ins),
        "output_tokens_mean": sum(outs) / len(outs),
        "input_tokens_max": max(ins),
        "output_tokens_max": max(outs),
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m harness.datasets", description=__doc__.split("\n\n")[0])
    p.add_argument("--kind", choices=("fixed", "lognormal"), required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--num-prompts", type=int, required=True)
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--input-len", type=int)
    p.add_argument("--output-len", type=int)
    for side in ("input", "output"):
        p.add_argument(f"--{side}-median", type=float)
        p.add_argument(f"--{side}-sigma", type=float)
        p.add_argument(f"--{side}-min", type=int)
        p.add_argument(f"--{side}-max", type=int)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.kind == "fixed" and (not args.input_len or not args.output_len):
        parser().error("--kind fixed needs --input-len and --output-len")
    if args.kind == "lognormal" and None in (
        args.input_median, args.input_sigma, args.input_min, args.input_max,
        args.output_median, args.output_sigma, args.output_min, args.output_max,
    ):
        parser().error("--kind lognormal needs all --input-* and --output-* distribution flags")
    summary = generate(args)
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
