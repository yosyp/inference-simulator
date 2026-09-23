// Production-CSP smoke test (00-build I4, §7.4). It drives the production build served with the
// production headers and fails on any CSP violation, console error, uncaught error, cross-origin
// request, or fetch/XHR.
//
// Every UI step is required (X1b): the intro modal, the six tabs, and on each tab Play and Pause
// (the week timeline must advance), the Live / High-side toggle, one named parameter in the
// drawer (a fork), and Reset. The engine must run in a Web Worker bundled under /assets/.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectCleanRun, expectDocumentHeaders, installGuards } from './guards.ts';

const TAB_COUNT = 6;
// The drawer parameter changed on every tab. If a tab's drawer drops it, name another here.
const DRAWER_PARAMETER = 'Load';
// Fast enough that the timeline's minute readout moves within a second or two of Play.
const PLAY_SPEED = '100×';
// Short wall-clock pauses so the worker computes, the canvas draws, and any late violation lands.
const SETTLE_MS = 500;
// How long the playhead may wait for the worker's first chunks (P1 is 3 s) before it must move.
const ADVANCE_TIMEOUT_MS = 10_000;

test('the production build runs under the production CSP', async ({ page, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('baseURL is not configured');
  const guards = await installGuards(page, baseURL);

  // Load the page. The document must carry headers.json exactly.
  const response = await page.goto('/');
  if (!response) throw new Error('No response for the document');
  await expectDocumentHeaders(response);
  await expect(page).toHaveTitle('Inference Simulator');
  await expect(page.getByRole('heading', { name: 'Inference Simulator' }).first()).toBeVisible();

  // The intro modal (05 §2) opens on every load.
  const modal = page.getByRole('dialog', { name: 'Inference Simulator' });
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Start exploring' }).click();
  await expect(modal).toBeHidden();

  // Every tab renders its own scenario, charts, and drawer, so exercise the toolbar on each.
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(TAB_COUNT);
  for (let i = 0; i < TAB_COUNT; i++) {
    const tab = tabs.nth(i);
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(SETTLE_MS);
    await exerciseToolbar(page);
  }

  // The engine ran in a bundled worker file (CLAUDE.md: never inline or blob:).
  expect(guards.workers.length, 'Web Workers started').toBeGreaterThan(0);
  for (const url of guards.workers) {
    expect(new URL(url).pathname, `worker script ${url}`).toMatch(/^\/assets\//);
  }

  await page.waitForTimeout(SETTLE_MS);
  await expectCleanRun(page, guards, testInfo);
});

// The toolbar and drawer (U6, 05 §4) on the selected tab.
async function exerciseToolbar(page: Page): Promise<void> {
  const timeline = page.getByRole('slider', { name: 'Simulated time' });
  const forks = page.getByRole('button', { name: /^Fork at / });

  // Play: the worker streams chunks, the canvas draws, and the playhead moves. Then Pause.
  await page
    .getByRole('radiogroup', { name: 'Playback speed' })
    .getByRole('radio', { name: PLAY_SPEED, exact: true })
    .click();
  const before = await timeline.getAttribute('aria-valuetext');
  await page.getByRole('button', { name: /^play\b/i }).click();
  await expect(timeline).not.toHaveAttribute('aria-valuetext', before ?? '', {
    timeout: ADVANCE_TIMEOUT_MS,
  });
  await page.getByRole('button', { name: /^pause\b/i }).click();
  await expect(page.getByRole('button', { name: /^play\b/i })).toBeVisible();

  // The Live / High-side toggle (05 §9): High side, then back to Live.
  await checkRadio(page.getByRole('radio', { name: 'High side', exact: true }));
  await page.waitForTimeout(SETTLE_MS);
  await checkRadio(page.getByRole('radio', { name: 'Live', exact: true }));

  // The parameters drawer: open it, change one named parameter (a fork), and close it.
  const drawerButton = page.getByRole('button', { name: 'Parameters', exact: true });
  await drawerButton.click();
  await expect(drawerButton).toHaveAttribute('aria-expanded', 'true');
  const panelId = await drawerButton.getAttribute('aria-controls');
  const panel = page.locator(`[id="${panelId}"]`);
  await expect(panel).toBeVisible();
  const slider = panel.getByRole('slider', { name: DRAWER_PARAMETER, exact: true });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(forks).toHaveCount(1);
  await drawerButton.click();
  await expect(drawerButton).toHaveAttribute('aria-expanded', 'false');

  // Reset (K16) restarts the tab from its entry point and drops the fork.
  await page.getByRole('button', { name: /^reset\b/i }).click();
  await expect(forks).toHaveCount(0);
  await page.waitForTimeout(SETTLE_MS);
}

async function checkRadio(radio: Locator): Promise<void> {
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}
