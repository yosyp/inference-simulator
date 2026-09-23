# Inference Simulator — 01 Product and Rationale

Status: scoping complete; kickoff review applied (September 2026). Personal project; build not started.
Related docs: 00-build (build plan), 02-simulator, 03-benchmarks, 04-stack, 05-ui-ux, 06-deployment.

## 1. Product statement

An interactive browser simulator of what happens when you serve a large language model inside a fixed-capacity enclave: a known number of GPUs, a known analyst population, no autoscaling, and no way to add hardware when load spikes.

The user scales from one analyst on one GPU, to many analysts on one GPU, to many analysts across several replicas. Throughput, time-to-first-token (TTFT), tail latency, and KV cache utilization respond live. Six one-click behaviours each isolate one lesson. A telemetry toggle shows the same run as the off-site team would see it: a delayed, aggregated daily rollup.

## 2. Audience

Forward-deployed engineers, netops, sysops, product managers, and others who deploy and maintain LLM systems on FedRAMP and IC high-side networks (IL5, IL6, top secret networks such as C2E). These systems have real scaling constraints and little visibility into system behavior and logging. The audience is highly technical but often unfamiliar with inference internals (prefill vs. decode, batching, KV cache). The goal is intuition about the systems they maintain.

| Persona | Brings | Takes away |
|---|---|---|
| FDE | Deploys and configures serving stacks | Routing policy choice; session affinity; how engine behavior drives latency |
| NetOps | Load balancers, sticky sessions, consistent hashing | Breaking stickiness costs GPU time; remapping after failure; retry amplification |
| SysOps | Owns hosts, outages, recovery | Replica loss and rejoin; cold start; preemption; what rollups hide |
| PM | Owns capacity and budget | N replicas do not deliver N× capacity; the memory ceiling; what "healthy" averages hide |

Design rules:

- **Single stream.** One teaching path for everyone; no role-based paths (they would multiply the complexity tree).
- **Personas as a review checklist.** Check every feature against all four personas during the build.
- **Tooltips orient; scenarios teach.**
- **Self-serve first (K5).** The primary v1 use is a shared link opened alone on a desktop browser, with nobody narrating. Each tab must teach through its entry point, sidebar text, and live status line.

## 3. Rationale

1. **Fixed capacity.** The enclave has a fixed number of GPUs and a known analyst population. There is no autoscaling and no way to add hardware during a spike. Every lesson happens inside that constraint.
2. **Progressive complexity.** One analyst on one GPU, then many analysts on one GPU, then many analysts across replicas. Each stage adds one dimension and ends at the limit that motivates the next.
3. **The ceiling is memory, not compute.** Engineers arriving from web services assume they run out of CPU. Here nvidia-smi reports the GPU as busy, compute utilization shows headroom, and KV cache sits at 98%. The scheduler begins preempting running requests and recomputing prefill it already paid for. Throughput looks flat and healthy while p99 knees upward, which average latency hides completely.
4. **Least-busy routing can be the wrong answer.** Round-robin ignores load. Least-outstanding counts requests, not their cost, because output length is unknown at dispatch. It also ignores where a conversation's history is cached: an analyst's follow-up sent to the idle replica re-prefills the whole conversation. Session-aware routing trades some load imbalance for a large TTFT win on returning turns.
5. **You cannot see the system you are operating.** On the high side there is no live dashboard, no phone-home telemetry, and no engineer connecting from outside. What leaves the enclave is a reviewed, aggregated rollup arriving hours or days later. The simulator shows the same incident twice: the god view, then the egress view, where the spike flattens into a daily average and the shape disappears. That subtraction is the part nobody designs for until they have lived it.

## 4. Scope

**In scope for v1**

- The three-stage progression (section 5) and six behaviour tabs (section 6).
- Hardware presets: 1–2 GPUs (measured), Server A with 4 replicas, and Server B with 8 replicas (both extrapolated).
- A five-day simulated work week per tab.
- The Live / High-side telemetry toggle on every tab. Diagnosis from sparse telemetry is taught through this toggle.

**Out of scope for v1**

- Logging, authentication, session persistence.
- Autoscaling.
- Tensor parallelism: 1 GPU = 1 replica throughout.
- KV transfer or offload between GPUs or to CPU.
- Prefill/decode disaggregation.
- Role-based learning paths.

**Candidate topics considered and deferred:**

- Tokens, not requests, as the unit of load
- Sizing from users to concurrency to GPUs
- Model size, quantization, and parallelism layout
- Engine settings as capacity decisions
- Application design cost (prompts, RAG, agents, reasoning output)
- Mixed workloads and noisy neighbors
- Gray failure (slow but alive replicas)
- Planned maintenance at N−1
- Network-path effects on perceived latency

## 5. Learning progression

Design rule: each stage adds one new dimension and ends at the limit that motivates the next stage.

| Stage | New dimension | Concepts introduced | Tabs | Ends at |
|---|---|---|---|---|
| a. 1 analyst, 1 GPU | None (baseline) | Tokens; prefill vs. decode; TTFT vs. TPOT; weights and KV share GPU memory; decode is memory-bandwidth bound | 1 | GPU mostly idle; one analyst can't use it |
| b. Many analysts, 1 GPU | Concurrency | Queueing; continuous batching; paged KV blocks; KV pool as the shared ceiling; chunked prefill; prefix caching and eviction; preemption and recompute; admission control | 2, 3 | Memory ceiling reached; the only fix is another GPU |
| c. Many analysts, many replicas | Placement | See below | 4, 5, 6 | — |

Placement notes:

- Paged attention belongs in stage (b). It is how one GPU divides its KV memory among concurrent requests, and prefix caching is built on the same blocks.
- Hot vs. cold cache first appears in (b): a returning session is hot if its blocks haven't been evicted. Stage (c) adds the question of which replica holds them.

**Stage (c) concepts**

1. **Replica independence.** Each GPU holds a full copy of the weights and its own KV pool. Compute and memory add up across replicas; cache contents do not.
2. **Session affinity and recompute cost.** A follow-up routed away from its history's replica prefills the entire conversation again. The cost grows with conversation length.
3. **Cache hit rate as effective capacity.** Every hit is prefill work not done. Under round-robin, a returning session lands on its original replica only about 1/N of the time.
4. **Shared prefixes.** A common system prompt is computed once per replica. It is a small cost, but it shows that cold replicas pay a warm-up cost.
5. **Locality vs. balance.** Affinity concentrates sessions and can overload a replica. Least-outstanding balances load but scatters sessions. Weighted scoring trades between the two.
6. **Load signals.** Request count ignores request cost. Signals are sampled with a delay, so a burst can pile onto the replica that looked idle.
7. **Hotspots and per-replica eviction.** One replica's KV can reach its ceiling and evict while the fleet as a whole has free memory.
8. **Fleet tail latency.** Fleet p99 is set by the worst replica. Imbalance shows in p99 before the mean moves.
9. **Replica loss.** Survivors absorb both the extra traffic and the recompute of lost histories. The latency impact exceeds the 1/N capacity loss.
10. **Remapping.** With mod-N hashing, losing one replica remaps most sessions: about 7/8 on 8 replicas, versus about 1/8 with consistent hashing.
11. **Rejoin.** A recovered replica has an empty cache and low load, so least-outstanding floods it with cold traffic. Recovery time is weight load plus warm-up.

**Sub-progression within stage (c)**

| Step | Content | Preset | Tab |
|---|---|---|---|
| c1 | 2 replicas, round-robin, single-turn requests. Capacity roughly doubles and routing looks irrelevant. | 2 replicas (measured) | 4, with mean turns per session set to 1 |
| c2 | Add multi-turn sessions. Round-robin now recomputes history. This is where routing starts to matter. | 2 replicas | 4 (default) |
| c3 | Switch among the five routing policies. | 2 replicas | 4 |
| c4 | Hotspots, remapping, fleet p99. | Server B | 5 |
| c5 | Replica fail and rejoin, then the retry storm. | Server B, then Server A | 5 (fail and rejoin), 6 (retry storm) |

**Concept-to-tab mapping (K4).** Each stage (c) concept has one tab that must demonstrate it, and each tab's lesson assertions (00-build) check it.

| Tab | Concepts taught (numbered list above) |
|---|---|
| 4 Routing | 1 replica independence; 2 affinity and recompute cost; 3 hit rate as capacity; 4 shared-prefix warm-up; 5 locality vs. balance; 6 delayed load signals |
| 5 Fail and recover | 7 hotspots and per-replica eviction (survivors absorb the lost sessions); 8 fleet p99 set by the worst replica; 9 replica loss; 10 remapping; 11 rejoin |
| 6 Retry storm | 8 fleet tail latency and 9 replica loss, extended by retry amplification and admission control |

**Persona hooks for stage (c):**

- **NetOps** already know sticky sessions and consistent hashing. The new fact is that breaking stickiness costs GPU time.
- **SysOps** own replica loss and rejoin.
- **PMs** see that N replicas do not deliver N× capacity.
- **FDEs** choose the routing policy.

## 6. Tabs

Each tab is bound to one hardware preset and resets to a known state (decision Q8). Only tabs 4 and 6 have a named fix (decision Q14). Full definitions are in 02-simulator, section 10.

Each tab's work week contains its **lesson moment** at a scheduled day and time (K1). On tabs 5 and 6 that moment is an incident (a replica crash). On tabs 1–3 it is a workload change: a long prompt, a rate increase, or long conversations. On tab 4 it is a busy stretch under round-robin. Because the moment is in the baseline week, the timeline can mark it, the High-side rollup can show it, and the tracked analyst can be chosen to span it. The tab's one-click trigger forks the run at the playhead and re-applies the same change there, so the visitor can experiment. Lesson moments fall Monday to Thursday so the next day's rollup arrives inside the week (K2).

| Tab | Behaviour | Stage | Preset | Named fix |
|---|---|---|---|---|
| 1 | Long prompt: TTFT scales with prompt length; TPOT grows only slowly (K3) | a | 1 GPU | — |
| 2 | Saturation knee: p99 diverges from mean near capacity | b | 1 GPU | — |
| 3 | KV exhaustion: memory ceiling, preemption, recompute | b | 1 GPU | — |
| 4 | Routing policies | c | 2 replicas (measured) | Switch routing policy |
| 5 | Replica fail and recover | c | Server B, 8 replicas (proposed) | — |
| 6 | Retry storm | c | Server A, 4 replicas (proposed) | Backoff and admission control |

## 7. Hardware presets

| Preset | Replicas | Basis | On-screen label |
|---|---|---|---|
| Local | 1–2 | Measured on the author's 2×A100 server | Measured |
| Server A | 4 | Extrapolated from per-replica measurements | Extrapolated |
| Server B | 8 | Extrapolated from per-replica measurements | Extrapolated |

The analyst population scales with replica count, so every preset runs at the same load per replica (decision Q9). Specifications and extrapolation limits are in 03-benchmarks.

## 8. Telemetry model

| Element | Live (default) | High side |
|---|---|---|
| Whose view | Omniscient | Off-site team (program office, vendor, FDE home team) |
| Canvas | Request dots, KV tanks, router | Feed goes quiet; tanks and dots hidden |
| Charts | Full time series | Daily bars for latency and utilization; KV panel reads "not collected on the high side" |
| Metrics | All | Requests served, mean end-to-end latency, mean nvidia-smi-style utilization. No error count. |
| Granularity | Per request and per replica | Daily, per replica |
| Latency of data | Immediate | Day N's rollup arrives at day N+1, 12:00 |
| Current day | Visible | Nothing until the rollup arrives |

A failed replica shows up on the high side only indirectly, as a drop in that replica's requests served.

## 9. Credibility

- No accuracy claim (decision Q7). A footnote states that values are calibrated on 2×A100 with Llama 3.1 8B, and that shapes transfer to other hardware while absolute numbers do not.
- Extrapolated presets are labeled as extrapolated.
- Utilization shows both nvidia-smi-style utilization and compute utilization (decision Q2). The gap between them is part of lesson 3.

## 10. Prior art and build rationale

No existing tool combines a staged progression with queueing, KV-aware routing, outage scenarios, and a high-side telemetry view.

| Tool | What it does | Gap relative to this product |
|---|---|---|
| BLIS (inference-sim/inference-sim) | Discrete-event cluster simulator with routing scorers, tiered KV, p99 TTFT/ITL/E2E; observe, replay, and calibrate against a live server | No documented replica crash or retry storm; no educational layer |
| Vidur (microsoft/vidur) | Profiled operators, config search, P90/P99 | Engine-fidelity research tool |
| LLMServingSim 2.0 | Cycle-level, heterogeneous hardware, p99 | Heavy build; hardware research focus |
| inference-lab (Doubleword) | vLLM facsimile with roofline; Rust/WASM | Optimistic; no failures |
| vllm-sr-sim (inference-fleet-sim) | Fleet sizing to a P99 TTFT SLO | Planning tool |
| NVIDIA AIConfigurator | Deployment config search | Steady-state estimates, no queueing tails |
| llm-d-inference-sim | Mock vLLM server | Emulation, not prediction |
| LLM Cluster Simulator (zhebrak) | Browser tool with Learn Mode (60 tasks) and RPG missions | Analytical parallelism, no serving dynamics |
| Modular LLM Inference Handbook tools | Single-concept visualizers | No system progression |
| BatchLab | Single-engine DES, p50/p95 | No replicas, no failures |
| Retry Storm Lab | Retry policy comparison | Generic, not LLM-specific |

Patterns to borrow:

- **BLIS** as an optional offline cross-check of engine output, and its cohort schema as a reference for the workload model.
- **BatchLab's** versioned scenario JSON as the pattern for resettable tab states.
- **Retry Storm Lab's** policy set (immediate, fixed, exponential, full jitter) and its metrics (amplification, peak demand, abandoned requests, recovery time).
- **Modular's** chunked-prefill visual for tab 1.
- **LLM Cluster Simulator's** WinningCriterion pattern, if goal-based challenges are ever added.

## 11. Decision log (Theme 1)

| ID | Question | Options considered | Decision |
|---|---|---|---|
| Q1 | How many replicas does v1 show? | Two only; two measured plus 4/8 extrapolated; slider 1–8 | Two measured plus 4 and 8 extrapolated |
| Q2 | What does "GPU has headroom" mean on screen? | Compute utilization; nvidia-smi utilization; both | Both; the gap is part of lesson 3 |
| Q3 | Which shared prefix drives the routing lesson? | Session history; shared document sets; both | Multi-turn session history |
| Q4 | Whose view is High side? | Off-site; on-site operator; three-way toggle | Off-site view |
| Q5 | How does an incident reach a daily rollup? | Full days at request level; incident window plus coarse day; compressed windows | Full days at request level, fast-forwarded (event-jumping) |
| Q6 | Where does diagnosis from sparse telemetry live? | Toggle only; start-in-High-side option; seventh tab | Toggle only |
| Q7 | Credibility claim? | None; measured-point overlays; validation page | No accuracy claim |
| Q8 | How do presets map to tabs? | Bound per tab; global selector; bound with override | Each tab bound to one preset |
| Q9 | Population across presets? | Scales with replicas; fixed; hand-set | Scales with replica count |
| Q10 | Session-aware routing mechanism? | Session-ID hashing; cache-aware matching; both | Session-ID hashing (enables the mod-N vs. consistent-hashing lesson) |
| Q11 | Which rollup metrics? | Latency type, utilization type, error count | Requests served, mean E2E latency, mean nvidia-smi utilization; no error count |
| Q12 | Rollup shape? | Daily vs. hourly; fleet vs. per replica; current-day handling | Daily cadence; per replica and 12-hour delivery lag (proposed, not objected to) |
| Q13 | Simulated horizon? | One day; work week; configurable | Work week, with the incident on one day |
| Q14 | Problem only, or problem and fix? | Observe only; fix on every tab; fix where it is the lesson | Fixes on tabs 4 and 6 only |

**Kickoff review (September 2026).** K-numbered decisions are global across docs 01–06; 00-build cites them.

| ID | Question | Options considered | Decision |
|---|---|---|---|
| K1 | Scheduled incident or one-click trigger? (Q13 fixed the incident on one day; 02 §10 described a trigger; the tracked analyst must span the incident.) | Scheduled lesson moment plus a trigger that re-fires it at the playhead; clean week with user-triggered incident; scheduled only, with the button seeking to it | Scheduled lesson moment in every baseline week; the trigger forks at the playhead and re-applies it |
| K2 | When can lesson moments fall? | Any weekday; Monday to Thursday; extend the horizon to Saturday 12:00 | Monday to Thursday, so day N's rollup (delivered N+1 at 12:00) arrives inside the week |
| K3 | Tab 1 lesson wording | "TPOT does not scale"; "TPOT grows slowly" | TPOT grows slowly. Each decode step reads 128 KiB of KV per context token, so at batch 1 the memory traffic per step grows +6% at 8k, +26% at 32k, and roughly doubles at ~120k tokens, where the KV read matches the 16 GB of weights. TPOT rises a little less, because of the fixed per-step overhead. The tab's long prompt defaults to 16–32k tokens, and the copy must not claim TPOT is constant. |
| K4 | Where do stage (c) concepts and steps live? | Leave to build; map explicitly | Explicit concept-to-tab mapping (§5); c4 moves to tab 5 |
| K5 | Primary v1 usage mode | Presenter-led; self-serve link; both | Self-serve link on desktop (viewport in 05, K15) |

## 12. Open items

1. **Tab 1 and the toggle.** Proposed: tab 1 runs a work week of one analyst's usage, so the toggle works on every tab (Q6). Build default: as proposed.
2. **Presets for tabs 5 and 6.** Proposed: tab 5 on Server B (the remapping lesson is strongest at 8 replicas) and tab 6 on Server A (a 25% loss triggers the storm). Build default: as proposed.
3. **Incident timing.** Monday to Thursday (K2). The exact day and time of each tab's lesson moment is set during scenario tuning (00-build C2, C3).
