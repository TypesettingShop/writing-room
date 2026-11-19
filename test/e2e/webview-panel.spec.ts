import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/package.json' with { type: 'json' };

async function command(page: Page, title: string) {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

const content = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

test.beforeEach(async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('webview'), manifest }]);
  await page.goto('/');
});

test('renders extension HTML, evaluates the context menu and preserves a retained panel when it moves', async ({ page }) => {
  await command(page, 'Fixture: Open Retained Webview');
  const frame = content(page);
  const output = frame.locator('#output');
  await expect(output).toHaveText(Array.from({ length: 100 }, (_, index) => index).join(','));
  const counter = frame.getByRole('button', { name: 'Count' });
  await counter.click();
  await expect(frame.locator('#count')).toHaveText('1');
  await counter.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fixture: Webview Context Action' }).click();
  await expect(output).toHaveText('Context action ran');
  await command(page, 'Fixture: Active Webview Action');
  await expect(output).toHaveText('Active action ran');

  await page.getByRole('tab', { name: 'Welcome' }).click();
  await expect(page.locator('iframe[title="Webview"]:visible')).toHaveCount(0);
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Fixture: Active Webview Action');
  await expect(page.getByRole('option', { name: 'Fixture: Active Webview Action' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await command(page, 'Fixture: Reveal Webview Beside');
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await expect(frame.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Close Fixture retained' }).click();
  await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);
});

test('discards hidden transient content, rejects its messages and emits one disposal', async ({ page }) => {
  await command(page, 'Fixture: Open Transient Webview');
  await content(page).getByRole('button', { name: 'Count' }).click();
  await expect(content(page).locator('#count')).toHaveText('1');

  await command(page, 'Fixture: Open Retained Webview');
  await expect(page.locator('iframe[title="Webview"]')).toHaveCount(1);
  await command(page, 'Fixture: Probe Webview State');
  await expect(content(page).locator('#output')).toHaveText('{"delivered":false,"transient":[[false,false,1]],"retained":[]}');

  await page.getByRole('tab', { name: 'Fixture transient' }).click();
  await expect(content(page).locator('#count')).toHaveText('0');
  await command(page, 'Fixture: Dispose Webview');
  await expect(page.getByRole('tab', { name: 'Fixture transient' })).toHaveCount(0);
  await command(page, 'Fixture: Probe Webview State');
  await expect(content(page).locator('#output')).toContainText('"transient":[[false,false,1],[true,true,1],"disposed"]');
});
