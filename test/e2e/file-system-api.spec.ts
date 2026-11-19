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

test('file watchers and operation participants run over RPC and search excludes folders', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system')]);
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Check File Events and Search');
  await page.getByRole('option', { name: /Check File Events and Search/ }).click();
  await expect(page.getByText('File events and search verified', { exact: true })).toBeVisible();
});

test('a file write in another tab reaches a workspace watcher', async ({ context, page }) => {
  const peer = await context.newPage();
  await Promise.all([page, peer].map(tab => seedInstalledExtensions(tab, [fixture('file-system')])));
  await Promise.all([page.goto('/'), peer.goto('/')]);
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Watch File From Other Tab');
  await page.getByRole('option', { name: /Watch File From Other Tab/ }).click();
  await expect(page.getByText('Watching other tab', { exact: true })).toBeVisible();
  await peer.keyboard.press('F1');
  await peer.getByRole('combobox').fill('Write File From Other Tab');
  await peer.getByRole('option', { name: /Write File From Other Tab/ }).click();
  await expect(peer.getByText('Other tab write verified', { exact: true })).toBeVisible();
  await expect(page.getByText('Other tab event verified', { exact: true })).toBeVisible();
});
