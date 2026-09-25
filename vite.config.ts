import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Engine, worker, data, scenarios, and scripts run in Node; UI code runs in jsdom.
const nodeTests = [
  'src/engine/**/*.test.ts',
  'src/worker/**/*.test.ts',
  'src/data/**/*.test.ts',
  'src/scenarios/**/*.test.ts',
  'scripts/**/*.test.ts',
];

// Whole-day simulation tests (~150 s of the ~240 s suite). TEST_TIER=fast skips them: CI runs the
// fast tier on ordinary pushes and PRs; `pnpm verify` locally and deploys to prod run everything.
const slowTests = [
  'src/worker/**/*.test.ts',
  'src/scenarios/tab*/lessons.test.ts',
  'src/ui/high-side/consistency.test.tsx',
  'src/engine/replica/jumping.test.ts',
  'src/engine/replica/integration.test.ts',
  'src/engine/failure/integration.test.ts',
  'src/engine/metrics/chunks.test.ts',
  'src/engine/oracle/**/*.test.ts',
  'src/playback/index/playback.test.ts',
];
const fastOnly = process.env.TEST_TIER === 'fast' ? slowTests : [];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    // No data: URIs for fonts or other assets; the production CSP only allows data: for images.
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  test: {
    // Headless engine tests run whole simulated hours; many agents share this host, so allow slack.
    testTimeout: 20_000,
    // `pnpm test:coverage` (CI uploads lcov to Codecov). Tests, fixtures, and the oracle
    // reference simulator are excluded; they aren't shipped code.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/testing/**',
        'src/fixtures/**',
        'src/engine/oracle/**',
        'src/test-setup.ts',
      ],
    },
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: nodeTests, exclude: fastOnly },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: [...nodeTests, ...fastOnly],
          setupFiles: ['src/test-setup.ts'],
        },
      },
    ],
  },
});
