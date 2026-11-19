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
  const titleCommand = page.getByRole('button', { name: 'Report Fixture Resource' });
  await expect(titleCommand).toHaveCount(1);
  await titleCommand.click();
  await expect(page.getByText('Fixture resource: Untitled-2', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Untitled-1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Report Fixture Resource' }).click();
  await expect(page.getByText('Fixture resource: Untitled-1', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
});

test('URL installation keeps commands with icon pairs and commands whose icons fail validation', async ({ page }) => {
  const location = extensionFixtureLocation('foundation');
  const fixtureOrigin = new URL(location).origin;
  const requested: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === fixtureOrigin) {
      requested.push(url.pathname);
    }
  });

  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Install Extension from Location');
  await page.getByRole('option', { name: /Install Extension from Location/ }).click();
  const input = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await input.fill(location);
  await input.press('Enter');
  await page.getByRole('option', { name: /Install Foundation Fixture/ }).click();

  await expect(page.getByRole('button', { name: 'Report Fixture Resource' })).toBeVisible();
  await page.reload();
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Report Fixture Code Action Kind');
  await page.getByRole('option', { name: /Report Fixture Code Action Kind/ }).click();
  await expect(page.getByText('Fixture code action kind: quickfix', { exact: true })).toBeVisible();
  await expect.poll(() => requested.some(path => path === '/foundation/icons/dark.svg')).toBe(true);
  expect(requested).not.toContain('/outside.svg');
});
