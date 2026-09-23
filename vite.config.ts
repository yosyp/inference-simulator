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
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: nodeTests },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: nodeTests,
          setupFiles: ['src/test-setup.ts'],
        },
      },
    ],
  },
});
