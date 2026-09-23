// One differential check: the engine (event-jumping on) against the oracle on one seed's workload,
// and, when they disagree, a report with enough context to debug: the workload, the mismatched
// fields, the diverging request's events on both sides, the first diverging event, whether E5's
// per-step mode agrees with the oracle (which splits scheduling-rule bugs from jumping bugs), and
// the first diverging engine step with the steps before it.

import type { Calibration } from '../calibration.ts';
import { REQUEST_STATE } from '../results.ts';
import {
  compareCounters,
  comparePools,
  compareRequests,
  firstDivergentEvent,
  firstDivergentStep,
  formatStep,
  requestEvents,
  type Mismatch,
} from './compare.ts';
import { runEngine, type EngineRunOptions } from './engine-run.ts';
import { engineLimitsOf, runOracle } from './sim.ts';
import type { OracleInput, RunResults } from './types.ts';
import { oracleWorkload } from './workload.ts';

const STATE_NAMES = new Map<number, string>(
  Object.entries(REQUEST_STATE).map(([name, code]) => [code, name]),
);

function stateName(code: number): string {
  return code === -1 ? 'arrived' : (STATE_NAMES.get(code) ?? `state ${code}`);
}

export interface SeedCheck {
  input: OracleInput;
  engine: RunResults;
  oracle: RunResults;
  mismatches: Mismatch[];
}

/** Runs one seed's workload on the engine and the oracle and compares them. */
export function checkSeed(
  seed: number,
  cal: Calibration,
  options: EngineRunOptions = {},
): SeedCheck {
  const input = oracleWorkload(seed, cal);
  return checkInput(input, options);
}

export function checkInput(input: OracleInput, options: EngineRunOptions = {}): SeedCheck {
  const engine = runEngine(input, options);
  const oracle = runOracle(input);
  return { input, engine, oracle, mismatches: compareAll(engine, oracle) };
}

export function compareAll(engine: RunResults, oracle: RunResults): Mismatch[] {
  return [
    ...compareRequests(engine, oracle),
    ...compareCounters(engine, oracle),
    ...comparePools(engine, oracle),
  ];
}

export function describeInput(input: OracleInput): string {
  const lim = engineLimitsOf(input.config, input.cal);
  const p = input.config.tunable;
  const router =
    input.config.replicas > 1
      ? `${input.config.replicas} replicas, ${p.routingPolicy}` +
        (p.routingPolicy === 'sessionAffinity' || p.routingPolicy === 'weighted'
          ? ` (${p.hashScheme})`
          : '') +
        `, signal refresh ${p.signalRefreshMs} ms`
      : '1 replica';
  const changes = input.replicaChanges
    .map((c) => `replica ${c.replica} → state ${c.state} at ${c.atMs.toFixed(3)} ms`)
    .join('; ');
  return [
    `${router}, router overhead ${input.config.routerOverheadMs} ms, admission limit ` +
      `${p.admissionLimitPerReplica ?? 'none'}; day ${input.day}; ${input.requests.length} requests`,
    `KV pool ${lim.kvPoolTokens} tokens in blocks of ${lim.blockSize}, max_num_seqs ` +
      `${lim.maxNumSeqs}, max_num_batched_tokens ${lim.maxNumBatchedTokens}, system prompt ` +
      `${p.systemPromptTokens}`,
    changes ? `replica changes: ${changes}` : 'no replica changes',
  ].join('\n  ');
}

function describeRequest(input: OracleInput, i: number): string {
  const s = input.requests[i]!;
  const when =
    s.after === undefined
      ? `at ${s.atMs.toFixed(3)} ms`
      : `${s.atMs.toFixed(3)} ms after #${s.after} ends`;
  return (
    `request #${i}: session ${s.session} turn ${s.turn}, prompt ${s.promptTokens} ` +
    `(system ${s.systemPromptTokens}), output ${s.outputTokens}, arrives ${when}` +
    (s.timeoutMs === undefined ? '' : `, timeout ${s.timeoutMs.toFixed(3)} ms`) +
    (s.cancelAtMs === undefined ? '' : `, cancel at ${s.cancelAtMs.toFixed(3)} ms`)
  );
}

function describeEvents(run: RunResults, i: number): string {
  return requestEvents(run, i, stateName)
    .map(([t, what]) => `${t.toFixed(6)} ${what}`)
    .join(', ');
}

function fmt(v: number | string): string {
  return typeof v === 'number' && !Number.isInteger(v) ? v.toPrecision(12) : String(v);
}

/** A readable account of a failed check. Reruns both sides with step traces (slow; failures only). */
export function explain(check: SeedCheck): string {
  const { input, engine, oracle, mismatches } = check;
  const lines = [
    `E10 oracle: seed ${input.seed} disagrees with the engine (${mismatches.length} mismatches)`,
    `  ${describeInput(input)}`,
    'Mismatches (engine vs oracle; times are offsets from arrival):',
  ];
  for (const m of mismatches.slice(0, 12)) {
    const who = m.request >= 0 ? `#${m.request}` : 'meter';
    lines.push(`  ${who} ${m.field}: ${fmt(m.engine)} vs ${fmt(m.oracle)}`);
  }
  if (mismatches.length > 12) lines.push(`  … and ${mismatches.length - 12} more`);

  const ev = firstDivergentEvent(engine, oracle, stateName);
  const focus = ev?.request ?? mismatches.find((m) => m.request >= 0)?.request;
  if (ev) {
    const side = (e: [number, string] | null) =>
      e ? `${e[1]} at ${e[0].toFixed(6)} ms` : '(nothing)';
    lines.push(
      `First diverging event: request #${ev.request}, event ${ev.index}: ` +
        `engine ${side(ev.engine)}, oracle ${side(ev.oracle)}`,
    );
  }
  if (focus !== undefined) {
    lines.push(`  ${describeRequest(input, focus)}`);
    lines.push(`  engine: ${describeEvents(engine, focus)}`);
    lines.push(`  oracle: ${describeEvents(oracle, focus)}`);
  }

  // Split rule bugs from jumping bugs: E5 per step against the oracle, both traced.
  const perStep = runEngine(input, { eventJumping: false, trace: true });
  const traced = runOracle(input, { trace: true });
  const stepMismatches = compareAll(perStep, traced);
  const at = ev ? ev.atMs : Infinity;
  if (stepMismatches.length === 0) {
    lines.push(
      'E5 with eventJumping false agrees with the oracle: the divergence is in event-jumping.',
    );
    const jumping = runEngine(input, { trace: true }).steps;
    const involved = new Set([0]);
    if (focus !== undefined) {
      for (const run of [engine, oracle]) involved.add(Math.max(0, run.requests.replica[focus]!));
    }
    const near = (steps: typeof jumping, r: number) =>
      steps.filter((s) => s.replica === r && s.atMs - engine.dayStartMs <= at).slice(-4);
    for (const r of [...involved].sort()) {
      lines.push(`  jumping engine, replica ${r}, last steps or spans starting by the divergence:`);
      for (const s of near(jumping, r)) lines.push(`    ${formatStep(s, engine.dayStartMs)}`);
      lines.push(`  oracle, replica ${r}:`);
      for (const s of near(traced.steps, r)) lines.push(`    ${formatStep(s, oracle.dayStartMs)}`);
    }
  } else {
    lines.push(
      `E5 with eventJumping false also disagrees with the oracle (${stepMismatches.length} ` +
        'mismatches): a scheduling-rule difference, not event-jumping.',
    );
    const d = firstDivergentStep(perStep.steps, traced.steps);
    if (d) {
      lines.push(`First diverging step: replica ${d.replica}, step ${d.index} of its day`);
      lines.push(`  engine: ${formatStep(d.engine[d.index], perStep.dayStartMs)}`);
      lines.push(`  oracle: ${formatStep(d.oracle[d.index], traced.dayStartMs)}`);
      lines.push('  previous steps (identical on both sides):');
      for (const s of d.oracle.slice(Math.max(0, d.index - 4), d.index)) {
        lines.push(`    ${formatStep(s, traced.dayStartMs)}`);
      }
    }
  }
  lines.push(
    `Reproduce: checkSeed(${input.seed}, cal) in src/engine/oracle/differential.ts; ` +
      `ORACLE_SEED=${input.seed} pnpm vitest run --project node src/engine/oracle`,
  );
  return lines.join('\n');
}
