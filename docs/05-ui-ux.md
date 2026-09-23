# Inference Simulator — 05 UI/UX

Status: scoping complete; kickoff review applied (September 2026).
Related docs: 00-build (build plan), 01-product-and-rationale (tabs, telemetry model), 02-simulator (behaviours, metrics), 04-stack (rendering).

## 1. Layout

The simulator area takes 70% of the width and the sidebar takes 30%. The simulator area stacks the tabs, toolbar, canvas, three charts, and the week timeline.

Viewport (K15). The design target is 1440×900 CSS px, a common laptop size, since the primary use is a self-serve link on desktop (K5). The full stack needs about 850 px of height. Between 1280×720 and the target, the simulator column scrolls vertically. Below 1280×720, a notice asks for a larger window.

```
+-----------------------------------------------------+----------------------+
| Tabs: 1 Long prompt | 2 Knee | 3 KV | 4 Routing |   |                      |
|       5 Fail/recover | 6 Retry storm                |  Sidebar (30%)       |
+-----------------------------------------------------+  - Tab explanation   |
| Toolbar: [Trigger] [Live | High side] [Play] [Speed] |  - Live status line  |
|          [Parameters drawer]                        |  - Rollup table      |
+-----------------------------------------------------+    (High side)       |
| Canvas: router -> replicas (KV tanks, request dots) |  - Footnote:         |
+-----------------------------------------------------+    calibration,      |
| Chart 1: latency (mean vs p99)                      |    no accuracy claim |
| Chart 2: memory (KV %, preemption markers)          |                      |
| Chart 3: per tab                                    |                      |
|   (shared time axis, vertically aligned)            |                      |
+-----------------------------------------------------+                      |
| Week timeline: scrub, incident and fork markers     |                      |
+-----------------------------------------------------+----------------------+
```

## 2. Intro modal

Appears on every page load. It is dismissible and has no "don't show again" persistence. Target under ~120 words plus a "Start exploring" button.

Draft text (about 75 words):

> **Inference Simulator**
> An interactive model of serving a large language model inside a fixed-capacity enclave: a set number of GPUs, a known analyst population, and no way to add hardware when load spikes.
> Built for the engineers, operators, and program staff who run LLM systems on constrained, high-side networks.
> Calibrated on Llama 3.1 8B running on two NVIDIA A100 40GB GPUs; larger configurations are extrapolated.
> The tabs are a teaching order, and every parameter is adjustable.
> **[Start exploring]**

## 3. Tabs

- There are six tabs in teaching order. Each is bound to one hardware preset and resets to a known state: preset, seed, parameters, and tracked analyst.
- Extrapolated presets (Server A, Server B) carry an "Extrapolated" label.
- Tabs 4 and 6 expose a named fix; the others are observe-and-tweak.
- **Entry point (K16).** Each tab opens paused at its entry point, shortly before the scheduled lesson moment (01 §6), with a legible default speed. Play is the obvious first action. From the entry point, the lesson must be visible within about a minute of wall time. A jump control returns to the entry point.
- **Reset (K16).** Leaving a tab discards its forks; returning starts it fresh. A Reset control does the same in place.

## 4. Toolbar and parameters drawer (Q5)

- **Always visible:** the tab's one-click trigger, the Live / High-side toggle, play/pause, speed, jump to the lesson moment, and Reset.
- **Collapsible drawer:** tab-specific parameters, such as routing policy and hash scheme, arrival rate, timeout and retry policy, and admission limit.
- Changing a parameter mid-week forks the run at the playhead (04-stack §3). The charts and timeline mark the fork time.

## 5. Playback and timeline (Q1)

- **Speed control:** 1× to 1000×.
- **Week timeline:** a week-long, scrubbable timeline with incident markers and fork markers.
- **Speed threshold:** above it, the canvas hides individual dots and shows aggregate flow per replica, because dots are only legible at about 1–10×.
- **Off-shift skipping (K16):** playback skips hours outside analyst shifts (nights), and the timeline shows them shaded. A week is 432,000 s, so even 1000× would take over 7 minutes; with ~10-hour shifts, 1000× plays the five shifts in about 3 minutes.
- **Computed ranges:** the timeline shows which parts of the week the engine has computed. Days can finish out of order, because the lesson day goes first (04 §3, K21). The playhead cannot enter uncomputed time; if it reaches some, playback holds with a buffering indicator.

## 6. Charts (Q2)

Three charts are stacked with one shared time axis and vertically aligned, so the same vertical slice is the same moment.

| Chart | Content | Tabs |
|---|---|---|
| 1 Latency (fixed) | TTFT mean vs. p99 (lead), plus E2E p99 as a thinner secondary line (K14) | All |
| 2 Memory (fixed) | KV cache % with preemption markers | All |
| 3 Per tab | Utilization: nvidia-smi-style vs. compute | 1–3 |
| | Per-replica load | 4–5 |
| | Offered vs. admitted load (retry amplification) | 6 |

- **Multiple replicas:** a fleet line with the worst replica highlighted, which stays readable at 8 replicas.
- **Rendering:** React SVG with d3 scales, drawing at most one bucket per pixel column.
- **Percentiles:** computed from merged histograms, so any zoom level is exact to within about 1–2%. The scale spike may loosen this if the memory budget requires it (04 §7).
- **Sparse buckets:** when a bucket holds too few requests for a stable percentile, as on tab 1 with one analyst, the chart plots individual requests instead.
- **Why TTFT leads (K14):** E2E latency includes output length. With lognormal outputs, E2E p99 is already 3–5× the mean at idle, which blurs the knee. TTFT is the clean queueing signal. E2E remains the High-side metric, because that is what the rollup contains.

## 7. Canvas encoding (Q6)

- **Layout:** the router on the left, replicas on the right. Each replica shows a KV tank (fill = KV %) and its request dots.
- **Dot colors by state:** queued, prefill, decode, preempted. Use a colorblind-safe palette with a secondary cue (shape or outline) for preempted.
- **Tracked analyst:**
  - Each tab starts with a seed-chosen analyst whose session spans the tab's incident.
  - Their requests are traced across replicas and labeled with TTFT.
  - Clicking any dot switches tracking to that analyst.
- **Replica states:** Ready, Down (dark), and Loading (weight load, then engine init). A rejoining replica shows an empty tank.

## 8. Sidebar (Q4)

- **Static text per tab:** what to watch and why, plus two or three "Try this" suggestions (for example, "Switch routing to session affinity and watch the tracked analyst's next turn"). There is no presenter, so the text carries the lesson (K17).
- **Live status line:** generated from engine state through message templates, e.g. "Replica 3 is preempting; KV at 98%" or "Replica 5 is loading weights."
- **Rollup table** (High side only): days × replicas × three metrics. It is collapsible, because the daily bars carry the main signal and the table reaches 120 cells on Server B (K17).
- **Footnote:** calibration basis and no accuracy claim. While the calibration is provisional (03, K10), the footnote says so.

## 9. Telemetry toggle (Q3)

| Element | Live (default) | High side |
|---|---|---|
| Canvas | Dots, tanks, router activity | Feed goes quiet; tanks and dots hidden; replica outlines remain |
| Chart 1 | Time series | Daily bars per replica (mean E2E latency) |
| Chart 2 | KV % time series | Empty panel: "not collected on the high side" |
| Chart 3 | Tab-specific series | Daily bars per replica for utilization (nvidia-smi-style); other tab-specific series become empty panels |
| Sidebar | Text and live status | Text plus rollup table; the live status line is hidden |
| Timing | Immediate | Day N's rollup appears once the playhead passes day N+1, 12:00; the current day is empty |

The toggle is available on every tab. Switching back to Live restores the full view of the same run, which shows the subtraction directly.

## 10. Tooltips and accessibility

Tooltips are orientational only (what a control or element is). Scenarios and the sidebar do the teaching.

Accessibility baseline (K18):

- Tabs, toolbar, drawer, and timeline scrubbing work from the keyboard.
- `prefers-reduced-motion` turns off UI chrome animation. The canvas still follows the playhead, because that motion is the content.
- The live status line is an `aria-live="polite"` region.
- Dot and replica states never rely on color alone (§7).

## 11. Decision log (Theme 5)

| ID | Question | Options considered | Decision |
|---|---|---|---|
| Q1 | Moving through a work week? | Speed control plus timeline; auto-pacing per tab; focus-and-context window | Speed control (1×–1000×) plus scrubbable timeline with incident markers |
| Q2 | Which three charts? | Fixed three; two fixed plus per-tab third; user-selectable | Latency and memory fixed; third chart per tab |
| Q3 | Charts in High-side mode? | Keep slots with empty panels; collapse to table; both | Both: daily bars and empty panels, plus rollup table in sidebar |
| Q4 | How does the sidebar teach? | Static text; stepped narrative; static plus live status | Static text plus live status line |
| Q5 | Where do controls live? | Sidebar; toolbar; toolbar plus drawer | Toolbar for trigger, toggle, and playback; drawer for parameters |
| Q6 | Canvas encoding? | Uniform dots; colored by state; state plus tracked analyst | Colored by state plus a tracked analyst |

Carried from the draft: the 70/30 split, the intro modal on every load without persistence, orientational tooltips, and three stacked charts on a shared time axis.

**Kickoff review (September 2026).**

| ID | Question | Options considered | Decision |
|---|---|---|---|
| K14 | What does chart 1 lead with? | E2E mean vs. p99 (as drafted); TTFT mean vs. p99; per-tab choice | TTFT mean vs. p99, with E2E p99 secondary |
| K15 | Minimum viewport (open item 1) | Presenter at 1280×720; self-serve desktop | Design target 1440×900; scroll down to 1280×720; notice below that |
| K16 | Where does a tab open, and how does a week play? | Monday 00:00 at 1×; entry point near the lesson moment | Opens paused at an entry point before the lesson moment; jump control; off-shift hours skipped; explicit Reset; leaving a tab discards forks |
| K17 | Sidebar for self-serve visitors | Static text only; static text plus "Try this" | Static text plus "Try this" suggestions (still static, per Q4); rollup table collapsible |
| K18 | Accessibility baseline | None stated; baseline | Keyboard operation, reduced motion for chrome, `aria-live` status line, never color alone |
| K26 | Palette, encodings, and shell behavior (open item 2; decided in U1) | — | Okabe–Ito-based tokens with a non-color cue per state (`src/ui/theme/README.md` has contrast ratios and a deuteranopia/protanopia check). Tabs use manual activation, since switching tabs resets a run. Tabs, toolbar, and timeline stay fixed; only the canvas and charts scroll. The parameters drawer opens inline under the toolbar. The small-window notice is a banner, not a blocking screen. Fork, incident, and playhead markers use neutral ink plus a glyph, because any orange thin line matches the p99 vermillion under deuteranopia. |

## 12. Open items

1. Resolved by K15.
2. Resolved by K26.
3. The set of live status line templates per tab.
4. Speed threshold at which dots switch to aggregate flow.
5. Entry point (simulated time and speed) per tab; set during scenario tuning (00-build C2, C3).
