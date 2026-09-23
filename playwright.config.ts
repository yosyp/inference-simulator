import { defineConfig, devices } from '@playwright/test';

// Production-CSP smoke test (00-build I4, §7.4). `pnpm e2e` builds first, then this config serves
// dist/ with infra/site/headers.json through scripts/serve-prod.ts. Setting BASE_URL skips the
// local server and tests that site instead (X5 runs it against the deployed site).

const PORT = 4180;
const isCI = Boolean(process.env.CI);
const remoteBaseURL = process.env.BASE_URL;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: remoteBaseURL ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Controls may stay disabled while the worker computes the first chunk (P1 budget: 3 s).
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      // 1440×900 is the reference layout (05 §1), so the whole toolbar is on screen.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: remoteBaseURL
    ? undefined
    : {
        command: `pnpm exec tsx scripts/serve-prod.ts ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        // Never reuse: another worktree's server on this port would serve a different build.
        reuseExistingServer: false,
        timeout: 15_000,
      },
});
