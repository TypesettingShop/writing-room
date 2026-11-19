import { readFileSync } from 'node:fs';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect, test } from './fixtures.js';

function fixture(name: string) {
  const url = new URL(`../fixtures/extensions/${name}/package.json`, import.meta.url);
  return { manifest: JSON.parse(readFileSync(url, 'utf8')) as IExtensionManifest, location: extensionFixtureLocation(name) };
}

test('workspace.fs transfers bytes, enforces access, and preserves file errors over RPC', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system'), fixture('configuration-api')]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check File System API');
  await page.getByRole('option', { name: /Check File System API/ }).click();
  await expect(page.getByText('File System API verified', { exact: true })).toBeVisible();
});
