# Design tokens

Owner: U1. Spec: 05 §1, §7, §9, §10 (K15, K18); 04 §1; 06 §5.

The look is a quiet operations console: light gray chrome, ink text, one focus blue, and color reserved for data. Data hues come from the Okabe–Ito palette.

## Where tokens live

| What | Source of truth | Mirror for canvas and SVG |
|---|---|---|
| Colors | `@theme static` in `src/index.css` (`--color-*`) | `colors`, `okabeIto` in `colors.ts` |
| State encodings (shape, size, dash, hatching) | — | `dotStyles`, `replicaStyles`, `seriesStyles`, `markerStyles`, `trackedStyle`, `kvTankStyle` in `encodings.ts` |
| Fonts | `--font-sans`, `--font-mono`, `--text-2xs` | `fontStacks`, `fontSizes`, `canvasFonts` in `typography.ts` |
| Layout | `--layout-*` in `:root` | `layout`, `viewport` in `layout.ts` |
| Motion | — | `motionTokens`, `chromeTransition`, `usePrefersReducedMotion` in `motion.ts` |

`theme.test.ts` fails if the CSS and the TS mirror drift. To change a token, edit `src/index.css`, then the TS mirror, then rerun `palette.test.ts`.

How to use a color:

- **React:** Tailwind classes, e.g. `bg-surface`, `text-ink-muted`, `border-border-strong`, `stroke-series-p99`, `fill-dot-decode`.
- **SVG attributes and style props:** `cssVar('series-p99')` gives `var(--color-series-p99)`. `static` emits every variable, so this works even when no class uses the token.
- **Canvas:** the hex values in `colors`, or the style objects in `encodings.ts`. `withAlpha(hex, a)` makes an `rgba()` string.

Use the tokens, not Tailwind's default palette (`slate-*`, `blue-*`). The defaults stay available so nothing breaks, but they aren't checked.

## Palette

### Request dots (canvas, 05 §7)

Every state has a shape or size cue, so the dots read the same in grayscale.

| State | Color | Shape and size | Why |
|---|---|---|---|
| Queued | outline `dot-queued` #475569, white fill | small circle, r 2.5, outlined | Waiting: quiet and small |
| Prefill | `dot-prefill` #56B4E9 (Okabe–Ito sky), edge #2A6F97 | diamond, r 4.5 | Computing the prompt |
| Decode | `dot-decode` #0072B2 (Okabe–Ito blue), edge #005A8C | filled circle, r 4 | Streaming tokens |
| Preempted | `dot-preempted` #D55E00 (vermillion) | hollow ring, r 4.5, 2 px stroke | Evicted, will recompute |
| Tracked analyst | halo `dot-tracked` (ink) | 1.5 px ring 2 px outside the dot, plus a TTFT label | Follows one analyst |

Prefill and decode share the blue family on purpose: both are running on the GPU. They differ in lightness (L* 70 vs 46), which survives every kind of color blindness, and in shape.

### Replicas and KV tanks

| State (`ReplicaState`) | Fill | Outline | Other cue | Label |
|---|---|---|---|---|
| Ready | white | 1 px `replica-ready-stroke` #7A8594 | KV tank, fill `kv` #009E73 on `kv-track` #F0F2F5 | — |
| Loading weights, Starting engine | `replica-loading-fill` #FFF7E5 | 1.5 px dashed [5, 3] `replica-loading-stroke` | progress bar in `replica-loading` #E69F00 | "Loading weights 40%" / "Starting engine" |
| Down | `replica-down` #2B3440 | 1 px ink | diagonal hatching `replica-down-hatch`, every 6 px | "Down" in white |
| Crashed (dead, not yet marked down) | as Down | 2 px `replica-crashed-stroke` #D55E00 | hatching | "Crashed" in white |

`replicaStyle(state)` maps the engine's numeric `ReplicaState` to its style. A rejoining replica draws an empty tank (05 §7).

### Charts and markers (05 §6)

| Token | Color | Line | Suggested use |
|---|---|---|---|
| `series-mean` | #0072B2 blue | 1.5 px solid | Chart 1 TTFT mean; chart 3 the primary series (compute utilization, admitted load) |
| `series-p99` | #D55E00 vermillion | 2 px solid | Chart 1 TTFT p99, the lead line (K14) |
| `series-secondary` | #CC79A7 purple | 1.25 px dashed [4, 3] | Chart 1 E2E p99 (K14); chart 3 the contrasting series (nvidia-smi-style utilization, offered load) |
| `series-worst` | #000000 black | 1.5 px solid, with a direct label ("R3, worst") | The worst replica next to the fleet line |
| `series-muted` | #A3ADBA | 1 px solid | The other replicas, as context |
| `series-kv` | #009E73 green | 1.5 px solid | Chart 2 KV %; same hue as the canvas tank fill |
| `series-preemption` | #D55E00 vermillion | tick marks | Chart 2 preemption markers; same hue as preempted dots |
| `series-fork` | ink-muted #465162 | 1 px dashed [3, 3] plus a flag glyph and "Fork" | Fork markers on charts and timeline |
| `series-incident` | #F0E442 yellow band at 50% alpha, glyph edge `series-incident-stroke` (ink) | triangle glyph | Lesson moment and incidents |
| `series-playhead` | ink | 1.5 px solid plus a handle | Playhead cursor |
| `chart-grid`, `chart-axis` | #E6EAEF, #5F6B7A | — | Gridlines, ticks, and axis text |

Annotations (fork, incident, playhead) are neutral ink plus a glyph, not a hue. Every hue that is dark enough for a thin line on white is already taken by a data series. A darkened orange looks like vermillion under deuteranopia (ΔE 3.9), so it would clash with p99.

### High side (05 §9)

| Token | Use |
|---|---|
| `high-side-bar` #4F6D8A | Daily bars per replica. A steel blue, set apart from the live palette, because rollups are coarse and delayed. |
| `high-side-bar-pending` | Dashed outline for the current, still-empty day |
| `high-side-empty`, `high-side-empty-hatch`, `high-side-empty-ink` | "Not collected on the high side" panels; the `bg-hatch` utility draws the background |
| `high-side-outline` | The replica outlines that stay on the quiet canvas |
| `mode-high-side` #5B4A91 | The rule the shell draws across the top of the simulator column in High-side mode |

### Chrome

| Token | Hex | Use |
|---|---|---|
| `bg` | #F4F5F7 | Page |
| `surface`, `surface-muted` | #FFFFFF, #EDF0F3 | Panels; hover and pressed states |
| `border`, `border-strong` | #D3D9E0, #7A8594 | Dividers; control outlines |
| `ink`, `ink-muted`, `ink-subtle` | #151B26, #465162, #5F6B7A | Text: primary, secondary, tertiary |
| `focus` | #1C5FD4 | The 2 px focus ring on every focusable element |
| `warn-bg`, `warn-ink`, `warn-border` | #FDF3CD, #5C4400, #C9A227 | The viewport notice and the provisional-calibration badge |

## Checks

`palette.test.ts` asserts every threshold below, using the functions in `color-math.ts` that produced these figures.

### Contrast (WCAG 2.x)

Text needs 4.5:1. Graphics and control outlines need 3:1 (WCAG 1.4.11).

| Foreground | Background | Ratio |
|---|---|---|
| `ink` | `surface` | 17.26 |
| `ink` | `bg` | 15.82 |
| `ink-muted` | `surface` | 8.03 |
| `ink-muted` | `surface-muted` | 7.02 |
| `ink-subtle` | `surface` | 5.43 |
| `ink-subtle` | `bg` | 4.97 |
| `ink-subtle` | `surface-muted` | 4.74 |
| `surface` (button text) | `ink` | 17.26 |
| `surface` | `mode-high-side` | 7.41 |
| `warn-ink` | `warn-bg` | 8.27 |
| `replica-down-ink` | `replica-down` | 12.59 |
| `high-side-empty-ink` | `high-side-empty` | 7.23 |
| `chart-axis` | `surface` | 5.43 |
| `border-strong` | `surface` / `bg` | 3.74 / 3.43 |
| `focus` | `bg` / `surface-muted` | 5.29 / 5.05 |
| `dot-queued` | `canvas-bg` | 7.58 |
| `dot-prefill-stroke` | `canvas-bg` | 5.50 |
| `dot-decode` | `canvas-bg` | 5.19 |
| `dot-preempted` | `canvas-bg` | 3.87 |
| `dot-tracked` | `canvas-bg` | 17.26 |
| `replica-ready-stroke` | `canvas-bg` | 3.74 |
| `replica-loading-stroke` | `canvas-bg` | 8.03 |
| `replica-down` | `canvas-bg` | 12.59 |
| `replica-crashed-stroke` | `replica-down` | 3.26 |
| `kv` | `kv-track` | 3.05 |
| `series-mean` | `surface` | 5.19 |
| `series-p99` | `surface` | 3.87 |
| `series-secondary` | `surface` | 3.06 |
| `series-worst` | `surface` | 21.00 |
| `series-kv` | `surface` | 3.42 |
| `series-fork` | `surface` | 8.03 |
| `series-incident-stroke` | `series-incident` | 13.05 |
| `series-playhead` | `surface` | 17.26 |
| `high-side-bar` | `surface` | 5.40 |

Known exceptions below 3:1, each carried by another element that passes:

| Token | Ratio | What carries it |
|---|---|---|
| `dot-prefill` fill on white | 2.31 | Its 1 px edge `dot-prefill-stroke` (5.50) |
| `series-incident` band on white | 1.32 | The glyph's ink edge (13.05) and its label |
| `replica-loading` progress on `kv-track` | 2.01 | The dashed outline and the "Loading weights 40%" label |
| `series-muted` on white | 2.27 | Context lines only; the fleet and worst lines carry the data |
| `flow` on white | 2.50 | Aggregate flow is decorative; U3 should pair it with a rate label |

### Deuteranopia and protanopia

Method: simulate each color with the Machado, Oliveira & Fernandes (2009) matrices at severity 1.0, in linear sRGB, then take CIE76 ΔE in CIELAB (D65). Colors that share a view must stay at least **ΔE 20** apart under normal vision, deuteranopia, and protanopia. The code is in `color-math.ts`.

Dots (canvas):

| Pair | Normal | Deuteranopia | Protanopia |
|---|---|---|---|
| queued / prefill | 42 | 40 | 41 |
| queued / decode | 30 | 32 | 29 |
| queued / preempted | 90 | 80 | 67 |
| prefill / decode | 26 | 25 | 25 |
| prefill / preempted | 114 | 101 | 89 |
| decode / preempted | 115 | 108 | 92 |

Chart 1 (latency):

| Pair | Normal | Deuteranopia | Protanopia |
|---|---|---|---|
| mean / p99 | 115 | 108 | 92 |
| mean / secondary | 54 | 43 | 23 |
| mean / worst | 62 | 63 | 62 |
| p99 / secondary | 74 | 70 | 72 |
| p99 / worst | 94 | 85 | 72 |
| secondary / worst | 73 | 63 | 60 |

Chart 2 (memory):

| Pair | Normal | Deuteranopia | Protanopia |
|---|---|---|---|
| kv / preemption | 102 | 53 | 37 |
| kv / worst | 75 | 57 | 63 |
| preemption / worst | 94 | 85 | 72 |

Replicas: the Crashed and Down borders differ by ΔE 94 / 86 / 72. The other replica states differ by lightness, dash, or hatching, so they don't depend on hue.

The weakest pair is mean vs. secondary under protanopia (ΔE 23). Those two lines also differ in dash (solid vs. [4, 3]) and width.

Simulated appearance, for reference:

| Token | Normal | Deuteranopia | Protanopia |
|---|---|---|---|
| `dot-queued` | #475569 | #4A5369 | #4E566A |
| `dot-prefill` | #56B4E9 | #87A4E8 | #9BB3EC |
| `dot-decode`, `series-mean` | #0072B2 | #3B67B1 | #5375B5 |
| `dot-preempted`, `series-p99` | #D55E00 | #9E8C00 | #817100 |
| `series-secondary` | #CC79A7 | #9498A5 | #808BA9 |
| `series-kv` | #009E73 | #8A8676 | #9A9271 |
| `replica-loading` | #E69F00 | #CAB411 | #B9A200 |

The test also checks that every dot state has a unique (shape, size, fill) signature, and that each replica state differs from the others by outline, fill lightness, hatching, or label.

## Type

- System stacks only (`fontStacks.sans`, `fontStacks.mono`). There is no font CDN, and the production CSP allows fonts only from `'self'` (06 §5).
- Metrics use tabular numerals: the `tabular-nums` class in React, and `font-variant-numeric: tabular-nums` on SVG text. Canvas can't switch numerals, so numbers that update in place use `canvasFonts.numeric` (mono).
- Body text is `text-sm` (14 px), dense labels `text-xs` (12 px), and chart ticks `text-2xs` (11 px). Tailwind's other sizes are unchanged.

## Layout (05 §1, K15)

At the 1440×900 design target the stack fits without scrolling: tabs 44 + toolbar 48 + canvas 272 + 3 charts × 132 + timeline 72 = 832 px, plus borders. The shell keeps tabs and toolbar at the top and the timeline at the bottom; the canvas and charts scroll between them down to 1280×720. Below that, the frame stops shrinking, the page scrolls, and a notice asks for a larger window.

## Motion (K18)

Motion (`motion/react`) animates the modal, drawer, and tab indicator with `motionTokens` (120–260 ms, decelerating). Under `prefers-reduced-motion: reduce`, `chromeTransition` returns `{ duration: 0 }`, and a CSS rule in `src/index.css` zeroes CSS transitions. The canvas is exempt, because it follows the playhead and that motion is the content (05 §10). Don't use `AnimatePresence mode="popLayout"`: it injects a `<style>` element, which the production CSP blocks.
