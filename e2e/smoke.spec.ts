// Production-CSP smoke test (00-build I4, §7.4). It drives the production build served with the
// production headers and fails on any CSP violation, console error, uncaught error, cross-origin
// request, or fetch/XHR.
//
// Today's app is a placeholder shell. The modal, tabs, toolbar, and drawer arrive with U6 and are
// wired to the engine worker at X1. Until then each UI step below runs only if its control is
// present, and a step that finds nothing is reported as "not present yet". X1: once the real UI
// exists, replace each `IF PRESENT` branch with a hard `expect(...).toBeVisible()`.

import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectCleanRun, expectDocumentHeaders, installGuards } from './guards.ts';

// Short wall-clock pauses so the worker computes, the canvas draws, and any late violation lands.
const SETTLE_MS = 500;
const PLAY_MS = 1_500;

test('the production build runs under the production CSP', async ({ page, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('baseURL is not configured');
  const guards = await installGuards(page, baseURL);
  const notPresent = new Set<string>();

  // Load the page. The document must carry headers.json exactly.
  const response = await page.goto('/');
  if (!response) throw new Error('No response for the document');
  await expectDocumentHeaders(response);
  await expect(page).toHaveTitle('Inference Simulator');
  // The shell's h1 today; the intro modal carries the same heading (05 §2).
  await expect(page.getByRole('heading', { name: 'Inference Simulator' }).first()).toBeVisible();

  await dismissIntroModal(page, notPresent);

  // IF PRESENT: tabs (U6; the X1 registry decides which exist). Visit each one and exercise the
  // toolbar there, since each tab renders its own charts, drawer, and scenario. X1: require
  // at least the registered tab count.
  const tabs = page.getByRole('tab');
  const tabCount = await tabs.count();
  if (tabCount === 0) {
    notPresent.add('tabs');
    await exerciseToolbar(page, notPresent);
  }
  for (let i = 0; i < tabCount; i++) {
    const tab = tabs.nth(i);
    if (await tab.isDisabled()) continue;
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(SETTLE_MS);
    await exerciseToolbar(page, notPresent);
  }

  await page.waitForTimeout(SETTLE_MS);
  await expectCleanRun(page, guards, testInfo);

  if (notPresent.size > 0) {
    const description = [...notPresent].join(', ');
    testInfo.annotations.push({ type: 'not present yet', description });
    console.log(`Skipped steps whose controls are not present yet: ${description}`);
  }
});

async function isShown(locator: Locator): Promise<boolean> {
  return locator.first().isVisible();
}

// IF PRESENT: the intro modal (U6, 05 §2) appears on every load. It renders with the app, so it
// is either visible by now or not built yet. X1: require it.
async function dismissIntroModal(page: Page, notPresent: Set<string>): Promise<void> {
  const modal = page.getByRole('dialog');
  if (!(await isShown(modal))) {
    notPresent.add('intro modal');
    return;
  }
  const start = modal.getByRole('button', { name: /start exploring/i });
  if (await isShown(start)) {
    await start.first().click();
  } else {
    await page.keyboard.press('Escape');
  }
  await expect(modal).toBeHidden();
}

// A segmented toggle option may be a radio, a pressed button, a switch, or a checkbox.
function toggleOption(page: Page, name: RegExp): Locator {
  return page
    .getByRole('radio', { name })
    .or(page.getByRole('button', { name }))
    .or(page.getByRole('switch', { name }))
    .or(page.getByRole('checkbox', { name }))
    .first();
}

// The toolbar and drawer (U6, 05 §4). Each control is optional until X1.
async function exerciseToolbar(page: Page, notPresent: Set<string>): Promise<void> {
  // IF PRESENT: Play, briefly, so the worker streams chunks and the canvas draws; then Pause.
  const play = page.getByRole('button', { name: /^play\b/i });
  if (await isShown(play)) {
    await play.first().click();
    await page.waitForTimeout(PLAY_MS);
    const pause = page.getByRole('button', { name: /^pause\b/i });
    if (await isShown(pause)) await pause.first().click();
  } else {
    notPresent.add('Play');
  }

  // IF PRESENT: the Live / High-side toggle (05 §9). Switch to High side, then back to Live.
  const highSide = toggleOption(page, /^high[\s-]?side\b/i);
  if (await isShown(highSide)) {
    await highSide.click();
    await page.waitForTimeout(SETTLE_MS);
    const live = toggleOption(page, /^live\b/i);
    await ((await isShown(live)) ? live : highSide).click();
    await page.waitForTimeout(SETTLE_MS);
  } else {
    notPresent.add('Live/High-side toggle');
  }

  // IF PRESENT: the parameters drawer. Open it, change one parameter (a fork), and close it.
  const drawerButton = page.getByRole('button', { name: /parameters/i }).first();
  if (await isShown(drawerButton)) {
    if ((await drawerButton.getAttribute('aria-expanded')) !== 'true') await drawerButton.click();
    const panel = await drawerPanel(page, drawerButton);
    if (panel && (await changeOneParameter(panel))) {
      await page.waitForTimeout(SETTLE_MS);
    } else {
      notPresent.add('drawer parameter');
    }
    if ((await drawerButton.getAttribute('aria-expanded')) === 'true') await drawerButton.click();
  } else {
    notPresent.add('parameters drawer');
  }

  // IF PRESENT: Reset (K16) restarts the tab from its entry point.
  const reset = page.getByRole('button', { name: /^reset\b/i });
  if (await isShown(reset)) {
    await reset.first().click();
    await page.waitForTimeout(SETTLE_MS);
  } else {
    notPresent.add('Reset');
  }
}

// The drawer's panel: the element the button controls, or a region or group named for it.
async function drawerPanel(page: Page, drawerButton: Locator): Promise<Locator | null> {
  const id = await drawerButton.getAttribute('aria-controls');
  const name = /parameters/i;
  const panel = id
    ? page.locator(`[id="${id}"]`)
    : page.getByRole('region', { name }).or(page.getByRole('group', { name }));
  return (await isShown(panel)) ? panel.first() : null;
}

// Changes the first parameter control it finds in the drawer. Returns false if there is none.
// X1: target one named parameter per tab instead.
async function changeOneParameter(panel: Locator): Promise<boolean> {
  const slider = panel.getByRole('slider').first();
  if (await slider.isVisible()) {
    await slider.focus();
    await slider.press('ArrowRight');
    return true;
  }
  const spinButton = panel.getByRole('spinbutton').first();
  if (await spinButton.isVisible()) {
    await spinButton.focus();
    await spinButton.press('ArrowUp');
    return true;
  }
  const select = panel.locator('select').first();
  if (await select.isVisible()) {
    const options = await select.locator('option').count();
    const selected = await select.evaluate(
      (element) => (element as unknown as { selectedIndex: number }).selectedIndex,
    );
    if (options > 1) {
      await select.selectOption({ index: selected === 0 ? 1 : 0 });
      return true;
    }
  }
  const radio = panel.getByRole('radio', { checked: false }).first();
  if (await radio.isVisible()) {
    await radio.check();
    return true;
  }
  return false;
}
