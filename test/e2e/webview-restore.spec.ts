import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/restore/package.json' with { type: 'json' };

const stateKey = 'writing-room:storage:1:webview.states.v1';
const editorKey = 'writing-room:storage:1:memento/workbench.parts.editor';
const fixtureBase = () => new URL('restore/', extensionFixtureLocation('webview')).href;

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

const content = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

async function saveLayout(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
}

test.beforeEach(async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: fixtureBase(), manifest }]);
  await page.goto('/');
});

test('restores the pane position and JSON state, rejecting oversize updates', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('Webview state could not be saved')) {
      warnings.push(message.text());
    }
  });
  await command(page, 'Fixture: Open Restorable Webview');
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).toContain('count');
  await content(page).getByRole('button', { name: 'Save Oversize State' }).click({ clickCount: 2 });
  await expect.poll(() => warnings.length).toBe(1);
  expect(await page.evaluate(key => localStorage.getItem(key), stateKey)).not.toContain('999');
  await saveLayout(page);
  const serialized = await page.evaluate(key => localStorage.getItem(key), editorKey);
  expect(serialized).toContain('Restorable');
  expect(serialized).not.toContain('Increment');

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toBeVisible();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  await expect(content(page).locator('#counter')).toHaveText('2');
  await expect(content(page).locator('#serializer')).toHaveText('2');
  await expect(page.locator('.editor-group-container').first().getByRole('tab')).toHaveText(['Welcome', 'Restorable']);
});

test('keeps hidden restores lazy and isolates a serializer failure', async ({ page }) => {
  await command(page, 'Fixture: Open Restorable Webview');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await page.getByRole('tab', { name: 'Welcome' }).click();
  await saveLayout(page);
  const entryRequests: string[] = [];
  page.context().on('request', request => {
    if (request.url() === fixtureBase() + 'extension.js') {
      entryRequests.push(request.url());
    }
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toBeVisible();
  expect(entryRequests).toEqual([]);
  await page.getByRole('tab', { name: 'Restorable' }).click();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  expect(entryRequests).toHaveLength(1);

  await command(page, 'Fixture: Open Failing Restore');
  await expect(page.getByRole('tab', { name: 'Failing Restore' })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await saveLayout(page);
  await page.reload();
  await expect(page.getByText('The extension could not restore this Webview.')).toBeVisible();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
});

test('ignores late success for a closed tab and restores eligible tabs after host restart', async ({ page }) => {
  await command(page, 'Fixture: Open Late Restore');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await saveLayout(page);
  await page.reload();
  await expect(content(page).getByText('Waiting for release')).toBeVisible();
  await page.getByRole('button', { name: 'Close Late Restore' }).click();
  await command(page, 'Fixture: Open Restorable Webview');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await command(page, 'Fixture: Release Late Restore');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await expect(content(page).getByText('Late completion')).toHaveCount(0);

  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect(content(page).locator('#counter')).toHaveText('1');
  await command(page, 'Restart Extension Host');
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  await expect(content(page).locator('#counter')).toHaveText('1');
});

test('keeps a missing extension tab closable and deletes its stored state', async ({ page }) => {
  await command(page, 'Fixture: Open Restorable Webview');
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).toContain('count');
  await saveLayout(page);
  await page.addInitScript(() => {
    if (window.top === window) {
      localStorage.removeItem('writing-room:storage:0:extensions.user');
    }
  });
  await page.reload();
  await expect(page.getByText('The extension that provides this Webview is unavailable.')).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).not.toContain('webview-restore');
  await page.getByRole('button', { name: 'Close Restorable' }).click();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toHaveCount(0);
});
