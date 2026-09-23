// pnpm sim: run a scenario's lesson day headless and print its lesson summary (00-build C1).
//
//   pnpm sim <tab|all> [--day N] [--patch key=value ...] [--until HH:MM] [--window MIN] [--json]
//
//   <tab>     a tab id (routing), number (4), or folder name (tab4-routing); "all" runs every tab
//   --day     0-4 (Monday-Friday); default the lesson moment's day
//   --patch   a TunableParams change as a 'set' patch at the day's start, e.g.
//             --patch routingPolicy=sessionAffinity --patch admissionLimitPerReplica=null
//   --until   stop the day at this time of day instead of midnight
//   --window  minutes before and after the lesson moment to summarize (default 15)
//   --json    print the summary as JSON
//
// Scenario discovery, later sources replacing earlier ones by tab id:
//   1. fixtureScenarios() (src/fixtures/scenarios.ts), placeholders for every tab;
//   2. src/scenarios/tab*-*/index.ts, each exporting `scenario` (C2, C3);
//   3. src/scenarios/index.ts (the registry, X1), exporting `scenarios` as an array or a function
//      returning one.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dayOf, isDayIndex, MINUTE_MS, type DayIndex } from '../src/engine/time.ts';
import { fixtureScenarios } from '../src/fixtures/scenarios.ts';
import type { Scenario } from '../src/scenarios/schema.ts';
import {
  formatSummary,
  lessonSummary,
  parsePatchArgs,
  parseTimeOfDay,
  runScenarioDay,
  setPatchAtDayStart,
} from '../src/scenarios/testing/index.ts';

const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/scenarios');

export interface SimArgs {
  target: string;
  day?: number;
  patches: string[];
  untilTimeOfDayMs?: number;
  windowMs: number;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): SimArgs {
  const out: SimArgs = { target: '', patches: [], windowMs: 15 * MINUTE_MS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--json') out.json = true;
    else if (a === '--day') out.day = Number(value());
    else if (a === '--patch') out.patches.push(value());
    else if (a === '--until') out.untilTimeOfDayMs = parseTimeOfDay(value());
    else if (a === '--window') out.windowMs = Number(value()) * MINUTE_MS;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else if (out.target === '') out.target = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  if (out.target === '') throw new Error('Name a tab (id, number, or folder) or "all"');
  if (out.day !== undefined && !isDayIndex(out.day)) throw new Error('--day must be 0-4');
  if (!(out.windowMs > 0)) throw new Error('--window must be a positive number of minutes');
  return out;
}

export interface Found {
  scenario: Scenario;
  source: string;
}

function isScenario(v: unknown): v is Scenario {
  return typeof v === 'object' && v !== null && 'id' in v && 'sim' in v && 'lessonMoment' in v;
}

/** Every tab's scenario, keyed by tab id, from the sources listed at the top of this file. */
export async function discoverScenarios(dir: string = SCENARIOS_DIR): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const add = (s: Scenario, source: string) => found.set(s.id, { scenario: s, source });
  for (const s of fixtureScenarios()) add(s, 'fixture');
  const load = async (file: string) => {
    try {
      return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (e) {
      console.warn(`pnpm sim: skipping ${file}: ${(e as Error).message}`);
      return null;
    }
  };
  const folders = existsSync(dir) ? readdirSync(dir).filter((f) => /^tab\d+-/.test(f)) : [];
  for (const folder of folders.sort()) {
    const file = join(dir, folder, 'index.ts');
    if (!existsSync(file)) continue;
    const mod = await load(file);
    if (isScenario(mod?.scenario)) add(mod.scenario, `src/scenarios/${folder}`);
  }
  const registry = join(dir, 'index.ts');
  if (existsSync(registry)) {
    const mod = await load(registry);
    const list = typeof mod?.scenarios === 'function' ? mod.scenarios() : mod?.scenarios;
    if (Array.isArray(list)) {
      for (const s of list) if (isScenario(s)) add(s, 'src/scenarios/index.ts');
    }
  }
  return found;
}

/** Scenarios matching a tab id, number, or folder name, or all of them in tab order. */
export function selectScenarios(found: Map<string, Found>, target: string): Found[] {
  const all = [...found.values()].sort((a, b) => a.scenario.tab - b.scenario.tab);
  if (target === 'all') return all;
  const hit = all.filter(
    ({ scenario: s }) =>
      s.id === target || String(s.tab) === target || `tab${s.tab}-${s.id}` === target,
  );
  if (hit.length === 0) {
    const ids = all.map((f) => `${f.scenario.tab} ${f.scenario.id}`).join(', ');
    throw new Error(`No scenario "${target}". Known: ${ids}`);
  }
  return hit;
}

/** Runs pnpm sim and returns what it prints. */
export async function sim(argv: readonly string[]): Promise<string> {
  const args = parseArgs(argv);
  const chosen = selectScenarios(await discoverScenarios(), args.target);
  const outputs: string[] = [];
  const json: unknown[] = [];
  for (const { scenario, source } of chosen) {
    const day = (args.day ?? dayOf(scenario.lessonMoment.atMs)) as DayIndex;
    const changes = parsePatchArgs(args.patches, scenario.sim.tunable);
    const r = runScenarioDay(scenario, {
      day,
      untilTimeOfDayMs: args.untilTimeOfDayMs,
      patches: args.patches.length > 0 ? [setPatchAtDayStart(day, changes)] : [],
    });
    const summary = lessonSummary(r, args.windowMs);
    if (args.json) json.push({ source, patches: args.patches, ...summary });
    else {
      const patchNote = args.patches.length > 0 ? `  patches: ${args.patches.join(' ')}\n` : '';
      outputs.push(`${formatSummary(summary)}\n  source: ${source}\n${patchNote}`);
    }
  }
  return args.json
    ? JSON.stringify(json.length === 1 ? json[0] : json, null, 2)
    : outputs.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sim(process.argv.slice(2)).then(
    (text) => console.log(text),
    (e: unknown) => {
      console.error(`pnpm sim: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
