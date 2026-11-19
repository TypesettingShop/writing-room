import { readFileSync } from 'node:fs';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { expect, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';

const manifest = JSON.parse(readFileSync(new URL('../fixtures/extensions/documents/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

test('an extension opens, reads and updates mirrored documents over RPC', async ({ page, pageErrors }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Document API');
  await page.getByRole('option', { name: /Check Document API/ }).click();
  await expect.poll(() => pageErrors[0] ?? null).toBeNull();
  await expect(page.getByText('Document API verified', { exact: true })).toBeVisible();
});

test('an extension opens split editors and applies versioned edits and snippets', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Text Editor API');
  await page.getByRole('option', { name: /Check Text Editor API/ }).click();
  await expect(page.getByText('Text Editor API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toHaveCount(2);
});
