import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect, test } from './fixtures.js';

const manifestUrl = new URL('../fixtures/extensions/configuration-api/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as IExtensionManifest;
const persistedSettingsKey = 'writing-room:storage:0:user.settings.json';
const settings = '{\n  // keep this comment\n  "configurationApi.greeting": "hi",\n  "unknown.key": [1,],\n}\n';

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title }).click();
}

async function open(page: Page): Promise<void> {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('configuration-api'), manifest }]);
  await page.addInitScript(({ key, value }) => {
    const seeded = 'writing-room:test:configuration-api-settings';
    if (window.top === window && !sessionStorage.getItem(seeded)) {
      localStorage.setItem(key, value);
      sessionStorage.setItem(seeded, 'true');
    }
  }, { key: persistedSettingsKey, value: settings });
  await page.goto('/');
}

test('an extension reads contributed settings for a language, writes one key and hears the change', async ({ page }) => {
  await open(page);
  await command(page, 'Report Fixture Configuration');
  // The extension's default for markdown beats the user's value for every language.
  await expect(page.getByText('Fixture configuration: greeting=hi markdown=markdown hello count=1', { exact: true })).toBeVisible();

  await command(page, 'Update Fixture Configuration');
  await expect(page.getByText('Changed: greeting=hi markdown=markdown hello count=5', { exact: true })).toBeVisible();
  await expect(page.getByText('Updated: greeting=hi markdown=markdown hello count=5', { exact: true })).toBeVisible();
  const persisted = await page.evaluate(key => localStorage.getItem(key), persistedSettingsKey);
  expect(persisted).toBe('{\n  // keep this comment\n  "configurationApi.greeting": "hi",\n  "unknown.key": [1,],\n'
    + '  "configurationApi.count": 5,\n}\n');

  await command(page, 'Update Fixture Workspace Configuration');
  await expect(page.getByText(/^Workspace update refused: .*does not support workspace settings/)).toBeVisible();
});
