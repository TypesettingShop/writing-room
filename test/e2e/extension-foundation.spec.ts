import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';

const manifestUrl = new URL('../fixtures/extensions/foundation/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as IExtensionManifest;

test('activates a seeded browser entry and forwards the target tab URI from its context menu', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('foundation'), manifest }]);
  await page.goto('/');
  for (let index = 1; index <= 2; index++) {
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
    await expect(page.getByRole('tab', { name: 'Untitled-' + index })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Report Fixture Resource' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Untitled-1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Report Fixture Resource' }).click();
  await expect(page.getByText('Fixture resource: Untitled-1', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
});
