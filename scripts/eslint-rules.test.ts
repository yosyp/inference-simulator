import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Proves each runtime rule in docs/04-stack.md §5 fires where it should, and not where it shouldn't.
const cwd = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('ESLint runtime rules', () => {
  it('bans Math.random in the engine', async () => {
    expect(await ruleIds('export const x = Math.random();\n', 'src/engine/x.ts')).toContain(
      'no-restricted-properties',
    );
  });

  it('allows Math.random outside the engine', async () => {
    expect(await ruleIds('export const x = Math.random();\n', 'src/ui/x.ts')).toEqual([]);
  });

  it('bans DOM, timers, and wall clock in the engine', async () => {
    for (const code of [
      'export const x = document.title;\n',
      'export const x = window.innerWidth;\n',
      'export const x = Date.now();\n',
      'export const x = performance.now();\n',
    ]) {
      expect(await ruleIds(code, 'src/engine/x.ts')).toContain('no-restricted-globals');
    }
  });

  it('bans UI and data imports from the engine', async () => {
    for (const spec of ['../ui/button', '../data/calibration', 'react', 'd3-scale']) {
      expect(await ruleIds(`import '${spec}';\n`, 'src/engine/x.ts')).toContain(
        'no-restricted-imports',
      );
    }
  });

  it('bans network and storage everywhere in src', async () => {
    for (const code of [
      "export const x = fetch('/x');\n",
      "export const x = localStorage.getItem('x');\n",
      "export const x = window.fetch('/x');\n",
      'export const x = new WebSocket("wss://x");\n',
    ]) {
      const ids = await ruleIds(code, 'src/ui/x.ts');
      expect(ids.some((id) => id.startsWith('no-restricted-'))).toBe(true);
    }
  });

  it('bans default exports in src', async () => {
    expect(await ruleIds('export default 1;\n', 'src/ui/x.ts')).toContain('no-restricted-syntax');
    expect(await ruleIds('const a = 1;\nexport { a as default };\n', 'src/ui/x.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('bans inline and query-string workers', async () => {
    expect(
      await ruleIds("import W from './w.ts?worker&inline';\nnew W();\n", 'src/playback/x.ts'),
    ).toContain('no-restricted-syntax');
  });

  it('bans three.js, GSAP, routers, and d3-transition', async () => {
    for (const spec of ['three', 'gsap', 'react-router-dom', 'd3-transition']) {
      expect(await ruleIds(`import '${spec}';\n`, 'src/ui/x.ts')).toContain(
        'no-restricted-imports',
      );
    }
  });
});
