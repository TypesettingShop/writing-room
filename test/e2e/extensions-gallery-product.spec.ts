import { expect, test } from '@playwright/test';
import { readProductConfiguration } from '../../src/platform/product/common/product.js';
import { enterLocation, fixtureOrigin, packageFolders, savedRecords } from './packages.helpers.js';

const gallery = readProductConfiguration(process.env.VITE_WRITING_ROOM_PRODUCT).extensionsGallery;
const realFixtureUrl = fixtureOrigin + '/openvsx';
const packageId = 'davidanson.vscode-markdownlint';
const sha256 = 'b6baf90037c903aa21b9c525972910561a903b82e12fe8d67220740ec15b1aa0';

test('keeps local installs visible when product settings disable Open VSX', async ({ page }) => {
  test.skip(gallery !== null, 'Set VITE_WRITING_ROOM_PRODUCT to {"extensionsGallery":null}.');
  const galleryRequests: string[] = [];
  await page.route(url => url.hostname === 'open-vsx.org' || url.pathname.startsWith('/openvsx'), route => {
    galleryRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+Shift+x');

  const search = page.getByRole('searchbox', { name: 'Search Open VSX' });
  await expect(search).toBeDisabled();
  await expect(page.getByText('Open VSX is unavailable.', { exact: true })).toBeVisible();
  await enterLocation(page, fixtureOrigin + '/remote');
  await page.getByRole('option', { name: /Install Remote Fixture/ }).click();
  await expect(page.getByRole('list', { name: 'Installed extensions' })
    .getByRole('button', { name: 'Uninstall Remote Fixture' })).toBeVisible();
  expect(galleryRequests).toEqual([]);
});

test('installs the pinned Open VSX release through the product-configured loopback redirect', async ({ page }) => {
  test.skip(gallery?.serviceUrl !== realFixtureUrl, 'Set the product gallery to the MASTER Open VSX fixture.');
  test.skip(process.env.E2E_REAL_EXTENSIONS !== 'available', 'MASTER reports the real extension cache unavailable.');
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await page.getByRole('searchbox', { name: 'Search Open VSX' }).fill('markdownlint');
  const results = page.getByRole('list', { name: 'Open VSX search results' });
  const result = results.getByRole('listitem').filter({ hasText: 'DavidAnson' });
  await expect(result).toContainText('0.62.1');
  const downloaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname === 'localhost' && url.pathname.startsWith('/openvsx-content/') && url.pathname.endsWith('.vsix');
  });
  await result.getByRole('button', { name: /^Install / }).click();
  const response = await downloaded;
  expect(response.ok()).toBe(true);
  expect(response.request().redirectedFrom()?.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openvsx\/.*\.vsix$/);

  const option = page.getByRole('option', { name: /^Install .*davidanson\.vscode-markdownlint/i });
  await expect(option).toContainText('Download host: localhost:' + process.env.E2E_EXTENSIONS_PORT);
  await expect(option).toContainText('SHA-256: ' + sha256);
  await expect(option).toContainText('Signature: verified');
  expect(await savedRecords(page)).toEqual([]);
  await option.click();
  const installed = page.getByRole('list', { name: 'Installed extensions' });
  const row = installed.getByRole('listitem').filter({ hasText: packageId });
  await expect(row).toContainText(packageId + ' · 0.62.1 · Open VSX');
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: packageId, version: '0.62.1', source: 'gallery', signature: 'verified', packageSha256: sha256,
  })]);
  expect(await packageFolders(page)).toContain('/extensions/' + packageId + '-0.62.1');
  await row.getByRole('button', { name: /^Uninstall / }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => savedRecords(page)).toEqual([]);
  await expect.poll(() => packageFolders(page)).toEqual([]);
});
