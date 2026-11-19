import { expect, test } from '@playwright/test';
import { readPins } from '../../scripts/lib/real-extensions.mjs';
import { enterLocation, fixtureOrigin, packageFolders, savedRecords } from './packages.helpers.js';
import { openVsxServiceUrl, requireRealExtensions } from './real-extensions.helpers.js';

// Select a scenario from the requested setting so a broken product parser fails the browser assertions.
function requestedGallery(raw: string | undefined): { serviceUrl?: string } | null | undefined {
  try {
    const settings = JSON.parse(raw ?? '{}') as { extensionsGallery?: { serviceUrl?: string } | null } | null;
    return settings?.extensionsGallery;
  } catch {
    return undefined;
  }
}

const gallery = requestedGallery(process.env.VITE_WRITING_ROOM_PRODUCT);
const packageId = 'davidanson.vscode-markdownlint';

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
  test.skip(gallery?.serviceUrl !== openVsxServiceUrl(), 'Set the product gallery to the MASTER Open VSX fixture.');
  requireRealExtensions();
  const pin = (await readPins()).extensions.find(release => release.id.toLowerCase() === packageId);
  if (!pin) {
    throw new Error('The MASTER fixture has no pinned markdownlint release.');
  }
  const { version, vsix: { sha256 } } = pin;
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await page.getByRole('searchbox', { name: 'Search Open VSX' }).fill('markdownlint');
  const results = page.getByRole('list', { name: 'Open VSX search results' });
  const result = results.getByRole('listitem').filter({ hasText: 'DavidAnson' });
  await expect(result).toContainText(version);
  const downloaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.hostname === 'localhost' && url.pathname.startsWith('/openvsx-content/') && url.pathname.endsWith('.vsix');
  });
  await result.getByRole('button', { name: /^Install / }).click();
  const response = await downloaded;
  expect(response.ok()).toBe(true);
  const redirect = response.request().redirectedFrom();
  expect((await redirect?.response())?.status()).toBe(302);
  expect(redirect?.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openvsx\/.*\.vsix$/);

  const option = page.getByRole('option', { name: /^Install .*davidanson\.vscode-markdownlint/i });
  const port = process.env.E2E_EXTENSIONS_PORT;
  await expect(option).toContainText('Source: 127.0.0.1:' + port);
  await expect(option).toContainText('The key comes from 127.0.0.1:' + port);
  await expect(option).toContainText('Download host: localhost:' + port);
  await expect(option).toContainText('SHA-256: ' + sha256);
  await expect(option).toContainText('Signature: verified');
  expect(await savedRecords(page)).toEqual([]);
  await option.click();
  const installed = page.getByRole('list', { name: 'Installed extensions' });
  const row = installed.getByRole('listitem').filter({ hasText: packageId });
  await expect(row).toContainText(packageId + ' · ' + version + ' · Open VSX');
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: packageId, version, source: 'gallery', signature: 'verified', packageSha256: sha256,
  })]);
  expect(await packageFolders(page)).toContain('/extensions/' + packageId + '-' + version);
  await row.getByRole('button', { name: /^Uninstall / }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(() => savedRecords(page)).toEqual([]);
  await expect.poll(() => packageFolders(page)).toEqual([]);
});
