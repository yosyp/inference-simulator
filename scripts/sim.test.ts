import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverScenarios, parseArgs, selectScenarios } from './sim.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('pnpm sim', () => {
  it('parses its arguments', () => {
    expect(
      parseArgs(['4', '--patch', 'routingPolicy=weighted', '--until', '11:00', '--json']),
    ).toMatchObject({ target: '4', patches: ['routingPolicy=weighted'], json: true });
    expect(() => parseArgs(['--day', '7', 'knee'])).toThrow(/--day/);
  });

  it('finds every tab by id, number, or folder name', async () => {
    const found = await discoverScenarios();
    expect(selectScenarios(found, 'all').map((f) => f.scenario.tab)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(selectScenarios(found, '4')[0]!.scenario.id).toBe('routing');
    expect(selectScenarios(found, 'tab2-knee')[0]!.scenario.id).toBe('knee');
    expect(() => selectScenarios(found, 'nope')).toThrow(/Known/);
  });

  it('runs a fixture scenario from the command line', () => {
    const out = execFileSync(
      join(ROOT, 'node_modules/.bin/tsx'),
      ['scripts/sim.ts', 'knee', '--until', '11:00', '--json'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const s = JSON.parse(out) as { id: string; before: { ttft: { count: number } } };
    expect(s.id).toBe('knee');
    expect(s.before.ttft.count).toBeGreaterThan(0);
  }, 60_000);
});
