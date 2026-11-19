import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect, test } from './fixtures.js';

async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox');
  await palette.fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

function fixture(name: string) {
  const url = new URL(`../fixtures/extensions/${name}/package.json`, import.meta.url);
  return { manifest: JSON.parse(readFileSync(url, 'utf8')) as IExtensionManifest, location: extensionFixtureLocation(name) };
}

test('workspace.fs transfers bytes, enforces access, and preserves file errors over RPC', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system'), fixture('configuration-api')]);
  await page.goto('/');
  await runCommand(page, 'Check File System API');
  await expect(page.getByText('File System API verified', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('file watchers and operation participants run over RPC and search excludes folders', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system')]);
  await page.goto('/');
  await runCommand(page, 'Check File Events and Search');
  await expect(page.getByText('File events and search verified', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('a file write in another tab reaches a workspace watcher', async ({ context, page }) => {
  const peer = await context.newPage();
  await Promise.all([page, peer].map(tab => seedInstalledExtensions(tab, [fixture('file-system')])));
  await Promise.all([page.goto('/'), peer.goto('/')]);
  await runCommand(page, 'Watch File From Other Tab');
  await expect(page.getByText('Watching other tab', { exact: true })).toBeVisible({ timeout: 15_000 });
  await runCommand(peer, 'Write File From Other Tab');
  await expect(peer.getByText('Other tab write verified', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Other tab event verified', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('another extension activates, watches and uses a file provider across host restart and removal', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system'), fixture('memfs')]);
  await page.goto('/');
  await runCommand(page, 'Check File System Provider');
  const verified = page.getByText('File System Provider verified', { exact: true });
  await expect(verified).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(verified).toBeHidden();
  await runCommand(page, 'Restart Extension Host');
  await runCommand(page, 'Check File System Provider');
  await expect(verified).toBeVisible({ timeout: 15_000 });
  await runCommand(page, 'Uninstall Extension...');
  await page.getByRole('option', { name: /fixture.memfs/ }).click();
  await runCommand(page, 'Check Removed File System Provider');
  await expect(page.getByText('Removed File System Provider verified', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('vscode.open and openTextDocument can read an extension file provider', async ({ page }) => {
  await seedInstalledExtensions(page, [fixture('file-system'), fixture('memfs')]);
  await page.goto('/');
  await runCommand(page, 'Open File System Provider Document');
  await expect(page.getByRole('tab', { name: 'welcome.txt' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.monaco-editor').getByText('memfs says hello', { exact: true })).toBeVisible({ timeout: 15_000 });
});
