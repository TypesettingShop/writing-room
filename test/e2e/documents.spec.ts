import { readFileSync } from 'node:fs';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { expect, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';

const manifest = JSON.parse(readFileSync(new URL('../fixtures/extensions/documents/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

test('an extension opens, reads and updates mirrored documents over RPC', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Document API');
  await page.getByRole('option', { name: /Check Document API/ }).click();
  await expect(page.getByText('Document API verified', { exact: true })).toBeVisible({ timeout: 15000 });
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

test('workspace edit preflights every target and editor decorations dispose', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Workspace Edit API');
  await page.getByRole('option', { name: /Check Workspace Edit API/ }).click();
  await expect(page.getByText('Workspace Edit API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  const decorated = page.locator('.monaco-editor span').filter({ hasText: /^text$/ });
  await expect(decorated).toHaveCSS('background-color', 'rgb(221, 238, 255)');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Clear Fixture Decoration');
  await page.getByRole('option', { name: /Clear Fixture Decoration/ }).click();
  await expect(page.locator('.monaco-editor [class*="wr-extension-decoration-"]')).toHaveCount(0);
});

test('tab groups, built-in commands and editor context actions use the target editor', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('documents'), manifest }]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Tab Groups API');
  await page.getByRole('option', { name: /Check Tab Groups API/ }).click();
  await expect(page.getByText('Tab Groups API verified', { exact: true })).toBeVisible({ timeout: 15000 });
  const editor = page.locator('.monaco-editor').filter({ visible: true }).first();
  await editor.getByText('tab content', { exact: true }).click({ button: 'right' });
  const action = page.getByRole('menuitem', { name: 'Fixture Actions: Report Fixture Editor Resource' });
  await expect(action).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Different Language Fixture Action' })).toHaveCount(0);
  await action.click();
  await expect(page.getByText('Editor menu resource: Untitled-1', { exact: true })).toBeVisible();
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check Reference Command');
  await page.getByRole('option', { name: /Check Reference Command/ }).click();
  await expect(page.getByRole('tree', { name: 'References' })).toBeVisible();
});
