// sessionPlan (api.ts Engine.sessionPlan): the day's sessions as their keyed scripts plan them,
// without simulating. E11 and the worker pick the tracked analyst from it.
//
// It walks the same candidate process as the module, starting from dayStartParams(input) and
// applying the day's patches in time order as the simulation would: 'set' patches change the
// parameters later sessions start with, loadSpike events scale the intensity for their duration,
// and workloadShift events override the workload of sessions starting in their window.
// A session's plan is what it does when every request finishes the instant it arrives: turn N+1 at
// turn N's arrival plus think time, ending at the shift's end or when the context is full. So with
// zero service time the simulated arrivals match the plan exactly; under load, later turns drift
// later (the coherence rule), and failures can end sessions early.

import type { DayRunInput, SessionSummary, TunableParams } from '../api.ts';
import { applySetChanges, dayStartParams, partitionPatches } from '../core/index.ts';
import { Source, u01, uniformInt } from '../rng/index.ts';
import { dayStartMs, DAY_MS, type DayIndex } from '../time.ts';
import {
  acceptCandidate,
  advanceCursor,
  buildEnvelope,
  createCursor,
  effectiveMultiplier,
} from './arrivals.ts';
import {
  drawMessageTokens,
  drawOutputTokens,
  drawThinkMs,
  drawTurns,
  fitMessage,
  fitOutput,
  sessionSystemPrompt,
} from './script.ts';
import { shiftedParams, workloadShiftAt, type WorkloadShift } from './shift.ts';

export function sessionPlan(input: DayRunInput): SessionSummary[] {
  const cfg = input.config;
  const day = input.day;
  const seed = cfg.seed;
  const params = dayStartParams(input);
  const patches = partitionPatches(input.patches, day).inDay;
  const env = buildEnvelope(cfg, day);
  const cursor = createCursor();
  const dayEnd = dayStartMs(day) + DAY_MS;
  const spikeMult: number[] = [];
  const spikeEnd: number[] = [];
  const shifts: WorkloadShift[] = [];
  const analysts = cfg.analystsPerReplica * cfg.replicas;
  const out: SessionSummary[] = [];
  let next = 0;

  while (advanceCursor(env, seed, day, cursor)) {
    const t = cursor.atMs;
    if (!(t < dayEnd)) break;
    // Patches apply before any event at their instant.
    while (next < patches.length && patches[next]!.atMs <= t) {
      const p = patches[next++]!;
      if (p.kind === 'set') applySetChanges(params, p.changes);
      else if (p.event.type === 'loadSpike') {
        spikeMult.push(p.event.multiplier);
        spikeEnd.push(p.atMs + p.event.durationMs);
      } else if (p.event.type === 'workloadShift') shifts.push(workloadShiftAt(p.event, p.atMs));
    }
    // A spike's end runs before a candidate at the same instant (LOAD_PRIORITY).
    let product = 1;
    for (let i = 0; i < spikeMult.length; i++) if (spikeEnd[i]! > t) product *= spikeMult[i]!;
    if (
      !acceptCandidate(env, seed, day, cursor, effectiveMultiplier(params.loadMultiplier, product))
    )
      continue;
    const session = cursor.index;
    const analyst = uniformInt(u01(seed, Source.sessionAnalyst, day, session), analysts);
    out.push(planSession(input, shiftedParams(params, shifts, t), session, analyst, t));
  }
  return out;
}

/** One session's script with zero service time; mirrors startSession and onRequestEnded. */
function planSession(
  input: DayRunInput,
  p: TunableParams,
  session: number,
  analyst: number,
  startMs: number,
): SessionSummary {
  const cfg = input.config;
  const day: DayIndex = input.day;
  const seed = cfg.seed;
  const maxLen = input.calibration.engine.maxModelLen;
  const shiftEnd = dayStartMs(day) + cfg.shift.endMs;
  const scripted = drawTurns(seed, day, session, p.turnsPerSessionMean);
  const sys = sessionSystemPrompt(p.systemPromptTokens, maxLen);
  let history = 0;
  let arriveMs = startMs;
  let turns = 0;
  for (let turn = 1; turn <= scripted; turn++) {
    let nextMs = arriveMs;
    if (turn > 1) {
      const think = drawThinkMs(
        seed,
        day,
        session,
        turn - 1,
        p.thinkTimeMedianMs,
        cfg.thinkTimeShape,
      );
      nextMs = Math.max(arriveMs + think, arriveMs);
      if (!(nextMs < shiftEnd)) break;
    }
    const drawn = drawMessageTokens(
      seed,
      day,
      session,
      turn,
      p.messageTokensMedian,
      cfg.messageTokensSigma,
    );
    const message = fitMessage(maxLen, sys, history, drawn);
    if (message === 0) break;
    arriveMs = nextMs;
    const output = drawOutputTokens(
      seed,
      day,
      session,
      turn,
      p.outputTokensMedian,
      cfg.outputTokensSigma,
      cfg.outputTokensMax,
    );
    history += message + fitOutput(maxLen, sys + history + message, output);
    turns = turn;
  }
  return { session, analyst, startMs, turns, plannedEndMs: arriveMs };
}
