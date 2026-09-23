# S1 · Scale spike report

Status: for review at G1 (September 2026). Code: `spikes/scale/` (throwaway; delete after G1).
Related: 00-build §5 S1 and §8 (budgets), 02-simulator §5–§8 and §11, 04-stack §3.

## 1. Summary

A deliberately simple Server B engine (8 replicas, knee-level load, ticking every engine step) runs a busy Wednesday in 7–8 s of wall time on this host. That is about 3,000–5,000 simulated seconds per wall second, and 2,200–3,900× once a realistic prefix cache is added. A knee-level week is 1.2–1.5M requests. Full per-request records plus transitions cost 154 bytes per request, so the week's records alone take 190–235 MB.

| Budget | Verdict | One line |
|---|---|---|
| P1 first frame ≤ 3 s | **Pass for entry ≤ 09:30; uncertain at 10:00; fail after ~11:00** (Server B, knee load) | 05:00→10:00 takes 3.0–3.7 s ticking at full fidelity; event-jumping should cut that to 1.5–2.7 s, plus 0.2–0.4 s to start |
| P2 fork ≤ 1 s | **Pass** (projected) | Restore 2–6 ms, then replay ≤ 15 sim-min at peak (0.28–0.35 s ticking) and one short chunk |
| P3 ≥ 1,000× at peak | **Pass** | 2,200–3,900× ticking with a prefix cache; projected 3,000–6,600× with event-jumping |
| P4 ≤ 400 MB | **Pass with detail on demand; fail with full records** | The records store alone is 315–390 MB per knee week; tracked-only with the recommended layouts is about 40 MB |
| P5 no long tasks | **Uncertain** | Not measurable in Node. A chunk transfer costs 0.14 ms, so the risk is main-thread indexing and rendering |
| P6 JS ≤ 300 KB | **Not affected** | The spike adds nothing to the bundle |

Recommendations, in one table (reasons in §6):

| Item | Recommendation |
|---|---|
| Chunk size | 5 simulated minutes. After init or a fork, send a 1-minute chunk first. Send one chunk for the off-shift night, not 5-minute empties. |
| Checkpoint interval | 15 simulated minutes, kept for the playhead's day. Keep at most hourly checkpoints for other days, or none. |
| bucketMs / histBucketMs | 10 s / 60 s, emitted only over each day's active window (06:30–18:00 here) |
| Histograms | Sparse (CSR) storage with 2× the current bins (ttft 192, tpot 128, e2e 192; bin ratio ≈ 1.075). If dense storage stays, use Uint16. |
| Per-request storage | Detail on demand for Server A and B (the tracked analyst always has full records). Full records for 1 GPU and 2 replicas. |
| Latest Server B entry | 09:30 is safe and 10:00 is likely. Server A can enter around 12:00 (projected); 1–2 replicas can enter at any time. |
| Prefix cache (E4) | Per-block owner arrays plus a per-session chain of cached blocks. No `Map` per block. "Evict" is a counter, never a transition. |

## 2. Method

**Engine** (`spikes/scale/engine.ts`, about 840 lines). It is one independent day (K21) over plain-data state.

- **Routing and load.** Round-robin with no router overhead. Open-loop diurnal session starts. Keyed per-session scripts (K6). The session-coherence rule from 02 §8.
- **Client timeouts.** Timeout to first token is 60 s. A timeout aborts the request and abandons the session; there are no retries.
- **KV.** Paged KV with a vLLM-V1-style doubly linked free queue per replica. The system prompt's full blocks are pinned and shared.
- **Scheduler.** Running requests in admission order, then waiting requests FCFS, within `max_num_batched_tokens` and `max_num_seqs`. Blocks are allocated per scheduled chunk. Preemption is recompute of the most recently admitted request, and no waiting request is admitted in a step that preempted.
- **Step time.** The 02 §6 roofline, with calibration from `benchmarks/derived/calibration.json` (provisional).
- **Stepping.** It ticks every engine step. It counts *segments*: maximal runs of decode-only steps with no event on that replica. A segment is what an event-jumping engine would process as one jump.
- **Prefix-cache options** (for the cost estimate):
  - `--prefix` puts every full history block in a `Map` keyed by (session, block index), with LRU eviction.
  - `--prefix=owner` does the same bookkeeping with typed arrays. Both give identical results.
- **Recording.** A recorder writes the real `ResultChunk` contract layout (`src/engine/results.ts`, `histogram.ts`). Scalar and histogram buckets use the contract's `binIndex`. Request records and transitions go into growable typed-array columns.
- **Checkpoints.** `structuredClone` of the state. Restoring a 10:30 checkpoint and running to 11:00 gives bit-identical counters, records and scalars in all three prefix modes.

**Workload** (`workload.ts`):
- 400 analysts per replica, 3,200 in total.
- 16 sessions per analyst per day before the day multiplier (the knee case) and 20 (the overload case). The scripts call this `--spa`, and the tables below say "spa 16" and "spa 20".
- Turns per session: geometric, mean 5. Message length lognormal (median 150, σ 0.8). Output length lognormal (median 300, σ 0.7, mean 383, capped at 4,096). Think time lognormal (median 90 s, σ 0.6). System prompt 800 tokens.
- Diurnal knots from the fixture: ramp from 06:30, peak at 10:30, lunch dip, 14:30 hump, end at 17:00.
- Numbers are for Wednesday (day multiplier 1.1) unless stated.

**Host.** A shared Xeon Platinum 8380 (Ice Lake-SP, 3.4 GHz turbo), Node 22.18, one thread per run. Other agents were running at the same time. Individual 30-minute windows vary ±30% between runs, so tables give ranges over 3–4 runs. Parallel runs on this host were about 40% slower, so all timings are serial.

**Scripts**, all under `spikes/scale/` and run with `pnpm exec tsx`, or `node --expose-gc --import tsx` for heap:

| Script | Measures |
|---|---|
| `run-day.ts` | Speed per window, event counts, knee stats (`--spa`, `--detail`, `--prefix[=owner]`, `--no-metrics`) |
| `week-heap.ts` | Heap for a 5-day week of chunks, full or tracked (`--detail`, `--chunk`) |
| `storage.ts` | Scalar and histogram bytes per layout; percentile error per bin count |
| `checkpoint.ts` | Checkpoint size, clone time, restore check, replay cost |

## 3. Load calibration: where the knee is

Peak window (10:30–11:00) per replica, fleet means:

| Sessions/analyst/day | Requests/day | Arrivals/s/replica | KV mean | Replica-buckets with KV ≥ 95% | Running | Waiting | TTFT p50 / p99 | Preemptions / timeouts per 30 min |
|---|---|---|---|---|---|---|---|---|
| 10 | 176,773 | 0.87 | 20% | 0% | 9.3 | 0.0 | 0.21 / 1.9 s | 0 / 0 |
| 14 | 247,267 | 1.22 | 38% | 0.6% | 17.1 | 0.1 | 0.24 / 2.1 s | 1 / 0 |
| 15 | 264,777 | 1.28 | 44% | 8% | 20.2 | 1.5 | 0.27 / 29 s | 419 / 0 |
| **16 (knee)** | **281,968** | **1.34** | **51%** | **18%** | **24.5** | **7.6** | **0.31 / 57 s** | **1,119 / 55** |
| 18 | 315,419 | 1.50 | 69% | 38% | 34.1 | 19.7 | 0.52 / 59 s | 2,341 / 115 |
| 20 (overload) | 346,465 | 1.63 | 84% | 67% | 44.5 | 39.8 | 22 / 59 s | 3,797 / 331 |

What this shows:

- The knee is sharp. Between 1.22 and 1.34 arrivals/s per replica, p99 TTFT goes from 2 s to the 60 s timeout, while the p50 barely moves. That is tab 2's lesson.
- **The knee is compute-bound, not KV-bound**, for this workload. Under round-robin nothing but the system prompt is cached, so every turn re-prefills its whole history: prefill is 87% of processed tokens (2,620 prefill vs. 383 decode tokens per request). KV fills only in bursts at the knee (18% of replica-buckets reach 95%). It stays mostly full only past the knee (spa 18–20). The "KV-limited batch, mostly full" state therefore coincides with overload here.
- Knee throughput is about **1.3 requests/s per replica**, roughly half of 02 §5's estimate of 3. The fixture's 3 sessions per analyst per day is about 5× below the knee.

I use spa 16 as the knee case and spa 20 as a heavy upper bound (KV mostly full, queues at the timeout). Scale numbers are given for both where they differ.

## 4. Numbers

### 4.1 Requests and events

| Quantity | Knee (spa 16), Wednesday | Knee week | Overload (spa 20), Wednesday |
|---|---|---|---|
| Sessions | 56,320 | 245,760 | 70,400 |
| Requests (arrivals) | 281,968 | **1,230,284** | 346,465 (1,526,327/week) |
| Model events (02 §4: arrive, dispatch, first token, finish, next turn, preempt, timeout) | ≈ 1.36M | ≈ 5.9M | ≈ 1.7M |
| Transitions recorded (all requests) | 1.41M (5.0 per request) | 6.16M | 1.76M |
| Engine steps | 10.2M (0.28M with prefill) | ≈ 50M | 8.5M |
| Segments (event-jumping work items) | 0.79M | ≈ 3.8M | 0.89M |
| Steps per segment: day / 10:30 peak | 13 / 6.9 | — | 9.6 / 4.2 |
| Steps per arrival per replica at peak | 18 | — | ≈ 10 |
| Block allocations = evictions once warm (prefix mode) | 51M | ≈ 250M | — |

02 §5 estimated 10–15M events per week. Measured: about 6M model events, 4M jump segments, 50M steps and 250M block evictions per knee week. Evictions happen per block, so they must stay counters.

### 4.2 Engine speed (tick engine, knee day, this host)

| Configuration | Day wall | Ramp 07:00–09:30, slowest 30 min | Peak 10:00–11:30, 30-min windows | 05:00→09:00 | 05:00→10:00 | 05:00→11:00 |
|---|---|---|---|---|---|---|
| No metrics, no records | 7.5 s | 3,660× | 2,790–5,010× | 1.7 s | 2.7 s | 3.9 s |
| Metrics (scalars + histograms) | 8.2 s | 3,660× | 2,930–3,730× | 1.9 s | 2.9 s | 4.1 s |
| Metrics + tracked records (4 runs) | 7.0–8.4 s | 3,040–4,110× | 2,980–5,320× | 1.9–2.0 s | 2.7–3.0 s | 3.5–4.2 s |
| Metrics + all records | 7.6 s | 4,200× | 4,060–4,510× | 1.9 s | 2.7 s | 3.6 s |
| + prefix cache, `Map`, double keys | 26.2 s | ≈ 1,220× | ≈ 1,060× | 4.7 s | 7.5 s | 10.9 s |
| + prefix cache, `Map`, small-integer keys | 20–21 s | — | — | — | — | — |
| **+ prefix cache, owner arrays (3 runs)** | **8.4–9.7 s** | **2,590–3,460×** | **2,190–3,940×** | **2.2–2.3 s** | **3.0–3.7 s** | **4.0–5.3 s** |
| Overload (spa 20), tracked | 9.4 s | 2,550× | 3,860–4,190× | 2.4 s | 3.6 s | 4.5 s |
| Overload, + owner prefix cache | 10.4 s | 2,340× | 2,780–3,300× | 2.7 s | 4.0 s | 5.2 s |

- Events per second (ticking, tracked): about 190k model events/s, 1.5M loop iterations/s and 38k requests/s.
- The morning ramp is as slow as the peak for a ticking engine. Small batches mean short steps: 49 steps/s per replica at 07:00, against 24 at 10:30.
- Event-jumping helps the ramp most (13–36 steps per segment against 7 at peak).
- Recording all records costs almost nothing extra in the engine. Their cost is memory (§4.3).
- 00:00→06:30 is effectively free. Session planning for the day takes 60–80 ms.

**Profile** (ticking, tracked, no prefix): `compose` 43%, `stepEnd` 25%, main loop 8%. That is about 76% per-step work, which is what event-jumping removes. Block release and allocation take 9%; arrivals, RNG, recording and GC about 15%. A first owner-array version truncated per-session JS arrays on every eviction, and block allocation alone took 20% of its time. Making eviction a single typed-array write brought prefix caching down to +15–35% over the baseline.

### 4.3 Heap for a full week (5 days, knee load, chunks held as the main thread would after transfer)

Measured with `--expose-gc` as `heapUsed + arrayBuffers` after GC, minus the baseline.

| Case | Chunk | Scalars | Histograms | Records | Transitions | Typed total | Measured total | Per-chunk object overhead |
|---|---|---|---|---|---|---|---|---|
| (a) full records | 1 min | 49.8 | 66.4 | 78.7 | 110.9 | 305.8 MB | **389 MB** | 84 MB |
| (a) full records | 5 min | same | | | | 305.8 MB | **324 MB** | 18 MB |
| (a) full records | 15 min | same | | | | 305.8 MB | **315 MB** | 9 MB |
| (a) full records, spa 20 (1.53M requests) | 1 min | 49.8 | 66.4 | 97.7 | 139.8 | 353.6 MB | **438 MB** | 84 MB |
| (b) tracked only | 1 min | 49.8 | 66.4 | 0.02 | 0.03 | 116.2 MB | **200 MB** | 84 MB |
| (b) tracked only | 5 min | same | | | | 116.2 MB | **134 MB** | 18 MB |

- **Heap per million requests:** 154 MB for records plus transitions. That is 64 bytes per record and 5.0 transitions × 18 bytes. Chunk overhead comes on top.
- **Per-chunk overhead:** each chunk carries about 60 typed arrays (34 scalar metrics, 3 histograms, 17 record columns, 5 transition columns). That costs about 12 KB of JS heap per chunk, whatever its size.
- **Transfer cost:** `structuredClone` with the buffers transferred took 0.14 ms per chunk (1.0 s for the week's 7,200 one-minute chunks).
- Scalars and histograms above use the contract's dense layouts over whole days. §4.4 shows the smaller options.

### 4.4 Scalar and histogram bytes per week (Server B, 9 series)

Scalars are dense Float32 with 34 metrics:

| bucketMs | Whole day | Active window only (06:30–18:00) |
|---|---|---|
| 10 s | 49.8 MB | 23.8 MB |
| 30 s | 16.6 MB | 7.9 MB |

Histograms are ttft + tpot + e2e. "Current" is `HISTOGRAM_SPECS` (96/64/96 bins). CSR means a Uint32 row pointer per (bucket, series), plus a Uint8 or Uint16 bin index and a Uint16 count per non-empty bin. Values in MB are whole day / active window.

| histBucketMs | Bins | Dense Uint32 | Dense Uint16 | CSR | Max count in a bin |
|---|---|---|---|---|---|
| 60 s | current (96/64/96) | 66.4 / 31.8 | 33.2 / 15.9 | **4.9 / 4.5** | 191 |
| 60 s | 2× (192/128/192) | 132.7 / 63.6 | 66.4 / 31.8 | **7.1 / 6.7** | 105 |
| 60 s | 4× (384/256/384) | 265.4 / 127.2 | 132.7 / 63.6 | 12.2 / 11.8 | 60 |
| 300 s | current | 13.3 / 6.4 | 6.6 / 3.2 | 1.3 / 1.2 | 711 |
| 300 s | 2× | 26.5 / 12.7 | 13.3 / 6.4 | 2.2 / 2.1 | 366 |

Uint16 is safe at both widths: the largest fleet count per bin per bucket is 191 at 60 s. Sums over zoom windows need Uint32 at query time, which the merge does anyway. Most bins are empty, so CSR makes bin count nearly free.

### 4.5 Checkpoints (8 replicas, knee day)

| Mode | Size | `structuredClone` | Replay 15 sim-min from 10:30 | Replay 30 sim-min |
|---|---|---|---|---|
| No prefix hashing | 0.81–1.06 MB | 2.0–4.8 ms | 281 ms | 570 ms |
| Owner-array prefix cache | 1.53–1.79 MB | 2.1–5.6 ms | 349 ms | 718 ms |
| `Map` prefix cache | 1.93–2.22 MB | 12.9–21 ms | 798 ms | 1,564 ms |

- The range runs from 07:30 to 14:00; the size peaks at 10:30–11:00.
- The breakdown at 10:30 (owner mode):
  - block tables (ref count Uint16, free-queue prev/next Int32) 700 KB;
  - prefix index (owner Int32, index Uint16, next-in-chain Int32) 700 KB;
  - 185 running and waiting requests 168 KB;
  - 1,016 active sessions 328 KB;
  - next-turn heap and timeouts 48 KB;
  - bucket accumulators 12 KB.
- The day's session plan (start times and analysts, about 0.7 MB) is regenerable from keys, so it is left out.
- A `Map` in the state clones 3–6× slower than typed arrays holding the same information.
- The block-index arrays could be Uint16, since the pool is 8,750 blocks. That saves about 0.5 MB per checkpoint.

### 4.6 Percentile error of the histograms (simulated TTFT, knee week, 1.23M samples)

Relative error against exact nearest-rank quantiles, shown as median / p95 / max over windows. A window counts if it has at least 10 samples for p50, 20 for p90 and 100 for p99.

| Spec (bin ratio) | Window | p50 | p90 | p99 |
|---|---|---|---|---|
| Current, 96 bins (1.155) | replica × 1 min | 2.3 / 8.5 / 15.5% | 2.6 / 9.0 / 15.5% | too few samples |
| | fleet × 1 min | 0.9 / 3.3 / 13.7% | 1.1 / 4.3 / 12.8% | 2.2 / 7.9 / 14.1% |
| | fleet × 5 min | 0.4 / 1.8 / 14.9% | 0.6 / 2.0 / 9.7% | 1.2 / 4.4 / 11.5% |
| | fleet × 1 h | 0.2 / 1.5 / 1.9% | 0.3 / 1.3 / 3.1% | 0.7 / 2.7 / 2.8% |
| **2×, 192 bins (1.075)** | replica × 1 min | 1.5 / 5.4 / 7.5% | 1.6 / 5.1 / 7.5% | too few samples |
| | fleet × 1 min | 0.6 / 2.3 / 6.9% | 0.8 / 2.8 / 6.5% | 1.3 / 4.5 / 7.0% |
| | fleet × 5 min | 0.3 / 1.5 / 6.9% | 0.4 / 1.6 / 6.7% | 0.7 / 2.7 / 5.0% |
| 3×, 288 bins (1.049) | fleet × 1 min | 0.5 / 1.9 / 4.8% | 0.6 / 2.3 / 4.7% | 1.0 / 3.4 / 4.8% |
| 4×, 384 bins (1.037) | fleet × 1 min | 0.4 / 1.6 / 3.6% | 0.5 / 1.9 / 3.7% | 0.8 / 2.6 / 3.6% |

- The worst case is bounded by one bin (ratio − 1). The median is about a sixth of that.
- The current spec meets 02 §11's "about 1–2%" only as a median. Its worst case is 14–15%.
- TPOT (64 bins, ratio 1.114) and E2E (96 bins, ratio 1.163) behave the same way. At 2× bins their fleet × 1 min p99 error is 0.9 / 3.2 / 5.5% and 1.5 / 4.9 / 7.8%.
- Full tables are in `storage.ts` output.

## 5. What a real engine at full vLLM fidelity would cost

The spike ticks every step and, by default, skips history hashing. For P3 and P1 the real engine differs in two opposite ways.

**Event-jumping (faster).**
- The count: 76% of tick time is per-step work (profile, §4.2). At peak there are 6.9 steps per segment, and 13 over the day.
- The assumption: a jump costs about 2–3 steps' worth of work. It is still O(batch): find the next finish or block crossing, apply k steps to each request, allocate the blocks crossed, and integrate levels across bucket edges.
- The result: the per-step share falls to 2/6.9 to 3/6.9 at peak and 2/13 to 3/13 over the day. Tick time scales by **0.49–0.59 at peak and 0.39–0.45 over a day**.
- This matches 02 §5's expectation of about one order of magnitude fewer steps, but the wall-time saving is only about 2×. Per-block and per-event work stays.

**Fidelity the spike leaves out (slower).**

| Item | Effect on the ticking spike | In a jumping engine | Basis |
|---|---|---|---|
| Prefix hashing + LRU eviction, `Map` per block | +175% (small-integer keys) to +250% (double keys) | Per-block, so not reduced (51M evictions/day) | Measured |
| Prefix hashing + LRU, owner arrays | +15–35% | Per-block, so not reduced | Measured |
| Preemption (recompute) | Already included: 2.8k/day at knee, 10–40k/day in overload | Included | Measured |
| Metrics recording (34 scalars, 3 histograms) | +5–10% | Similar, plus closed-form level integration per segment | Measured (noisy) |
| Records and transitions, detail 'all' | +0–3% | Same | Measured |
| Routing: least-outstanding, affinity, weighted, signal refresh | +1–2% (O(replicas) per dispatch; 282k dispatches/day; 1 s refresh = 36k events/day) | Same | Estimated |
| Retries, admission control, crash and rejoin | +0–5% on a normal day; a retry storm multiplies requests by its amplification | Same | Estimated |
| Session affinity (tab 5 may use it) | Fewer prefill tokens, so somewhat faster | Same | Reasoned |

**Net projection.**
- Full fidelity as measured: the spike with the owner-array prefix cache, i.e. real vLLM block reuse, eviction and preemption.
- Multiply by 0.45–0.6 for event-jumping (the peak figure; mornings save a little more), then by 1.1–1.2 for routing, retries, recording and failure handling. That gives **0.5–0.72 × the measured full-fidelity tick time**.
- P3 on this host: the slowest peak windows (2,190–3,310× across runs) become **about 3,000–6,600×**.
- P1 on this host, 05:00→10:00: 3.0–3.7 s becomes **1.5–2.7 s**, plus 0.2–0.4 s for worker start and first render.

**Laptop factor.** Not measured. A 2023 mid-range laptop core is typically as fast as, or up to 1.5× faster than, one Xeon 8380 core when plugged in, and can be 1.5–2× slower when throttled. Chrome's worker runs the same V8 as Node, but under the main thread's GC and rendering. Treat the projections as ±50%.

## 6. Recommendations

**Chunk size: 5 simulated minutes** (a multiple of 60 s and 10 s).
- Per-chunk object overhead is about 12 KB: 84 MB per week at 1-minute chunks, 18 MB at 5 minutes, 9 MB at 15 minutes.
- A 5-minute chunk at peak costs 60–140 ms to compute (ticking). At 1000× it plays in 300 ms, so the worker stays ahead.
- After init or a fork, send a 1-minute chunk first, to cut first-frame latency by about 100 ms.
- Emit one chunk across the off-shift night. Nights are skipped in playback (K16) and would otherwise produce about 160 empty chunks per day.

**Checkpoint interval: 15 simulated minutes, aligned to histBucketMs.**
- A fork is a restore (≤ 6 ms), a replay of ≤ 15 minutes (0.28–0.35 s ticking at peak, projected about 0.2 s jumping) and a 1-minute chunk: about 0.3–0.5 s, inside P2.
- Keep them for the playhead's day: about 46 checkpoints × 1–1.8 MB = 45–80 MB, or 35–60 MB with Uint16 block indices.
- Other days need only their standard morning state, which is free, or hourly checkpoints if P4 allows (about 15–20 MB per day).
- A fork right after scrubbing into another day then replays from that day's nearest checkpoint, so it can take as long as P1. The worker should build 15-minute checkpoints for a newly focused day in the background straight away.
- Thirty-minute checkpoints would halve the memory but put a peak fork at about 0.7–0.85 s ticking. That is too close to P2.

**bucketMs 10 s, histBucketMs 60 s.**
- At 1–10× playback, 30 s scalars step visibly.
- Sixty-second histograms give per-minute percentile lines and lose at most 1 minute at a fork cut (the fork cut rule in `protocol.ts`). At 300 s a fork would discard up to 5 minutes.
- Emit buckets only for each day's active window. With 10 s buckets, scalars are 24 MB per week, not 50.

**Histograms: sparse (CSR) with 2× the current bins** (ttft 192, tpot 128, e2e 192; ratio about 1.075).
- About 7 MB per week at 60 s, against 66 MB for today's dense Uint32.
- It halves the median error and caps it at about 7%, against 14–15% now (§4.6).
- Revise 02 §11's claim to "typically about 1%; at most one bin width, about 7.5%".
- If CSR is too much change, a fallback that is still better than today: dense Uint16 with 2× bins over the active window only, about 32 MB per week.
- Either way this changes the `HistogramBlock.data` type, a §4 contract. The integrator must approve it.

**Per-request storage: detail on demand for Server A and B** (02 §11, K7).
- Full records plus transitions cost 154 MB per million requests, which is 190–235 MB for a knee week.
- With checkpoints and the browser baseline, that breaks P4.
- The tracked analyst's records (about 300 per week) are always kept.
- Dots near the playhead, which are legible only at 1–10×, come from re-simulating one 15-minute checkpoint span with detail 'all'. That is about 0.3 s of compute and about 1–1.5 MB.
- Keep full records for 1 GPU and 2 replicas. A 2-replica knee week is about 0.3M requests, about 50 MB.

**Latest entry point (P1 ≤ 3 s), Server B at knee load:**

| Engine | 05:00→09:00 | 05:00→09:30 | 05:00→10:00 | 05:00→10:30 | 05:00→11:00 | Latest entry |
|---|---|---|---|---|---|---|
| Ticking, full fidelity (measured) | 2.2–2.3 s | 2.6–3.0 s | 3.0–3.7 s | 3.5–4.5 s | 4.0–5.3 s | **09:00** |
| Event-jumping (projected, + 0.2–0.4 s fixed) | 1.3–2.1 s | 1.5–2.6 s | 1.7–3.1 s | 2.0–3.6 s | 2.2–4.2 s | **09:30 safe, 10:00 likely** |

- Cost scales roughly with replicas × load. Server A (tab 6, 4 replicas) costs about half as much per simulated hour, so it can enter around 12:00 (projected) at the same per-replica load. Tabs 1–4 (1–2 replicas) can enter at any time.
- For tab 5, the diurnal curve is already at 88% of peak by 09:30, so a crash between 09:30 and 10:00 still happens under heavy load.
- If a later moment is needed, options in order of preference:
  - raise that day's load multiplier;
  - move the diurnal peak earlier;
  - ship a precomputed entry checkpoint as a lazily imported module. About 1.5 MB raw; it would need regenerating whenever the engine, calibration or scenario changes. Not recommended.

**P3 and P4 in a real engine.**
- P3 looks achievable with 2–6× margin on this host, even without event-jumping.
- P4 looks achievable only with detail on demand. The projected Server B total with the recommended layouts:
  - results store: about 24 MB scalars, about 7 MB histograms and about 8 MB chunk overhead, so about 40 MB;
  - checkpoints: 45–80 MB;
  - engine state: about 5 MB;
  - browser baseline for a React, canvas and SVG page: 100–150 MB (assumed, not measured).
- That comes to **about 200–280 MB against 400 MB**. With full records it is **about 470–620 MB**.

## 7. What the simplifications hide

- **No event-jumping.** The 2× saving is an estimate from step counts and a profile, not a measurement. The closed forms (E3) and the per-segment metric integration (E9) could cost more than assumed. The risk is bounded: the ticking engine already passes P3 on this host.
- **Knee character.** Under round-robin with provisional η_c = 0.5, the knee is prefill-bound. With session affinity (tab 4, maybe tab 5), history hits cut prefill and the batch grows toward the KV limit. Steps then touch more requests each, which slows a ticking engine somewhat, and the knee moves to more requests per day. Measured calibration (B3) will move it again. Records scale linearly with requests.
- **Prefix cache.** It is off in the headline runs; only its cost was measured. Under round-robin, history hits were 1.8% of prompt tokens, so its behaviour barely differs. Evictions reached 51M per day because every block allocation reuses a cached block once the pool is warm.
- **Not modelled.** Retries, admission control, crash and recovery, router overhead, and routing policies other than round-robin. Tab 6's retry storms raise offered load 2–3× for tens of minutes; Server A has half of Server B's replicas, so that stays within the numbers here.
- **Scheduler details.**
  - Blocks are allocated per scheduled chunk, as in vLLM V1. 02 §7 rule 1 instead says blocks for the uncached prompt at admission. The two agree when a prompt fits in one 8,192-token chunk, which almost all do here. They differ for tab 1's 16–32k prompts. E5 and the author should pick one.
  - Running requests are served in admission order, not strictly "all decodes first". It rarely matters, because partial prefills are rare.
- **Metrics.** Fleet-only metrics (rejected, retries, abandoned) are mostly zero here. Their bytes are counted, but not their compute.
- **Measurement.**
  - Node on a shared server, not Chrome on a laptop.
  - Heap is `heapUsed + arrayBuffers` in Node. Chrome's task manager also counts the renderer and DOM, which the P4 projection assumes rather than measures.
  - P5 can't be measured here.
- **Workload parameters** are fixture-like placeholders (E6 sets defaults). Longer outputs or conversations raise KV pressure and steps per request.

## 8. Notes for other work packages

| For | Note |
|---|---|
| E4 | Don't key cached blocks through a `Map`. Store (session, block index) per block in typed arrays (`owner` Int32, `ownerIdx` Uint16) and give each session a head block per replica, with a per-block `nextInSeq` chain. Eviction is then one typed-array write, and lookup walks the chain, validating the owner. Measured: identical behaviour to the `Map` version, about 2.4× faster overall, and a 0.4 MB smaller checkpoint that clones 3–6× faster. Use Uint16 block indices while the pool is under 65,536 blocks. |
| E4, E9 | Evict happens about 50M times per knee day (every allocation once the pool is warm). It is a scalar counter only, never a transition or engine event. |
| E5 | 02 §7 rule 1 (blocks for the whole uncached prompt at admission) and vLLM V1 (blocks per scheduled chunk) differ for prompts longer than `max_num_batched_tokens`. That matters for tab 1. |
| E5 | The ramp costs as much as the peak for a ticking engine, because small batches mean many short steps. Event-jumping pays off most there. |
| E6, C2, C3 | Knee at the 10:30 peak: about 1.3 arrivals/s per replica, with 400 analysts per replica × 16 sessions/day × 5 turns. The fixture's 3 sessions per analyst per day is far below the knee. |
| E9 | The contract's one-typed-array-per-metric layout costs about 12 KB per chunk. It is fine at 5-minute chunks; at 1 minute it adds 84 MB per week. |
| E11 | P1 is set by computing from the morning to the entry point. Profile `pnpm perf` against the §6 table, and time 05:00→entry, not only whole-day speed. |
| 02 §5, §11 | Update the estimates: about 1.3 requests/s per replica at the knee (not 3); about 6M model events, about 4M jump segments and about 50M steps per knee week. Percentile error is about 1% median, bounded by one bin width. |
