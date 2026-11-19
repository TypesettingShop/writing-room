import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fixtureOrigin, packageFolders, runCommand, savedIdentifiers, savedRecords } from './packages.helpers.js';

const sampleFolder = '/extensions/writing-room-tests.vsix-sample-1.0.0';
const confirmOption = (page: Page, action = 'Install') =>
  page.getByRole('option', { name: new RegExp('^' + action + ' VSIX Fixture .*writing-room-tests\\.vsix-sample') });

async function download(name: string): Promise<Buffer> {
  const response = await fetch(fixtureOrigin + '/vsix/' + name);
  return Buffer.from(await response.arrayBuffer());
}

async function chooseVsix(page: Page, name: string): Promise<Buffer> {
  const bytes = await download(name);
  const chooser = page.waitForEvent('filechooser');
  await runCommand(page, 'Install from VSIX', /Install from VSIX/);
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  return bytes;
}

async function enterLocation(page: Page, url: string): Promise<void> {
  await runCommand(page, 'Install Extension from Location', /Install Extension from Location/);
  const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await location.fill(url);
  await location.press('Enter');
}

async function expectNothingStored(page: Page): Promise<void> {
  expect(await savedRecords(page)).toEqual([]);
  expect(await packageFolders(page)).toEqual([]);
}

test('installs a chosen file after showing what will be installed, and runs it offline after a reload', async ({ page, context }) => {
  await page.goto('/');
  const bytes = await chooseVsix(page, 'sample.vsix');
  const choice = confirmOption(page);
  await expect(choice).toContainText('writing-room-tests · 1.0.0 · writing-room-tests.vsix-sample');
  await expect(choice).toContainText('Source: sample.vsix');
  await expect(choice).toContainText(`Size: ${bytes.length} bytes`);
  await expect(choice).toContainText('SHA-256: ' + createHash('sha256').update(bytes).digest('hex'));
  await expect(choice).toContainText('Signature: unsigned');
  await expect(choice).toContainText('engines.vscode ^1.80.0 is compatible with 1.148.0');
  await expectNothingStored(page);

  await page.getByRole('option', { name: 'Cancel' }).click();
  await expectNothingStored(page);

  await chooseVsix(page, 'sample.vsix');
  await confirmOption(page).click();
  const container = page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'VSIX Fixture' });
  await expect(container).toBeVisible();
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.vsix-sample', source: 'vsix', version: '1.0.0', signature: 'unsigned',
    location: 'vscode-userdata:' + sampleFolder + '/', packageSha256: createHash('sha256').update(bytes).digest('hex'),
    nls: { displayName: 'VSIX Fixture' },
  })]);
  expect(await packageFolders(page)).toEqual([sampleFolder, ...[
    'dist', 'dist/extension.js', 'media', 'media/icon.svg', 'package.json', 'package.nls.json',
  ].map(path => sampleFolder + '/' + path)].sort());

  await context.route(fixtureOrigin + '/**', route => route.abort());
  await page.reload();
  await expect(container).toBeVisible();
  await runCommand(page, 'Run VSIX Fixture', /Run VSIX Fixture/);
  await expect(page.getByText('VSIX extension ran.')).toBeVisible();
  await expect(page.getByText('VSIX fixture active')).toBeVisible();
  await expect(container.locator('.wr-deferred-icon')).toHaveCSS('background-image', /url\("blob:/);
  const titleCommand = page.getByRole('button', { name: 'Run VSIX Fixture' });
  await expect(titleCommand.locator('.wr-deferred-icon')).toHaveCSS('background-image', /url\("blob:/);
});

for (const [name, reason] of [
  ['broken.vsix', /end of central directory|not a ZIP|ZIP/i],
  ['no-manifest.vsix', /extension\/package\.json/],
  ['engine.vsix', /requires VS Code \^2\.0\.0, which does not include 1\.148\.0/],
  ['platform.vsix', /linux-x64/],
  ['oversize.vsix', /exceeds 52428800 bytes/],
  ['redirect.vsix', /Cannot download the package.*redirect/],
] as const) {
  test('rejects ' + name + ' from a URL and stores nothing', async ({ page }) => {
    await page.goto('/');
    await enterLocation(page, fixtureOrigin + '/vsix/' + name);
    await expect(page.getByRole('combobox', { name: 'Could not install extension' })).toBeVisible();
    await expect(page.getByRole('option', { name: /^OK / })).toContainText(reason);
    await expectNothingStored(page);
  });
}

test('refuses package URLs with credentials before downloading', async ({ page }) => {
  const requests: string[] = [];
  page.context().on('request', request => requests.push(request.url()));
  await page.goto('/');
  await runCommand(page, 'Install Extension from Location', /Install Extension from Location/);
  const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await location.fill('http://user:secret@127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT + '/vsix/sample.vsix');
  await expect(page.getByText('The extension URL must not contain credentials.')).toBeVisible();
  await location.press('Enter');
  expect(requests.filter(url => url.includes('/vsix/'))).toEqual([]);
});

test('replaces a version from a URL, then uninstalls without leaving a folder', async ({ page }) => {
  await page.goto('/');
  await enterLocation(page, fixtureOrigin + '/vsix/sample.vsix');
  await confirmOption(page).click();
  await expect.poll(() => savedIdentifiers(page)).toEqual(['writing-room-tests.vsix-sample']);

  await enterLocation(page, fixtureOrigin + '/vsix/sample-1.1.0.vsix?channel=test');
  const replace = confirmOption(page, 'Replace');
  await expect(replace).toContainText('Replaces version 1.0.0 (VSIX).');
  await expect(replace).toContainText('Source: ' + fixtureOrigin + '/vsix/sample-1.1.0.vsix');
  await replace.click();
  await expect.poll(async () => (await savedRecords(page)).map(record => record.version)).toEqual(['1.1.0']);
  await expect.poll(() => packageFolders(page)).not.toContain(sampleFolder);
  expect((await packageFolders(page)).filter(path => path.split('/').length === 3))
    .toEqual(['/extensions/writing-room-tests.vsix-sample-1.1.0']);

  await enterLocation(page, fixtureOrigin + '/vsix/sample-1.1.0.vsix');
  const before = (await savedRecords(page))[0].installedAt;
  await confirmOption(page, 'Reinstall').click();
  await expect.poll(async () => (await savedRecords(page))[0].installedAt).not.toBe(before);
  await expect.poll(async () => (await packageFolders(page)).filter(path => path.split('/').length === 3))
    .toEqual(['/extensions/writing-room-tests.vsix-sample-1.1.0']);

  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  const entry = page.getByRole('option', { name: /VSIX Fixture/ });
  await expect(entry).toContainText('writing-room-tests.vsix-sample · 1.1.0 · VSIX');
  await entry.click();
  await expect(page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'VSIX Fixture' })).toHaveCount(0);
  await expect.poll(() => packageFolders(page)).toEqual([]);
  expect(await savedRecords(page)).toEqual([]);
});

test('asks separately for a package without a browser entry and applies only its contributions', async ({ page }) => {
  await page.goto('/');
  await enterLocation(page, fixtureOrigin + '/vsix/node-only.vsix');
  const choice = confirmOption(page, 'Install Contributions Only');
  await expect(choice).toContainText('Not a web extension: only its contributions apply.');
  await choice.click();
  await expect(page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'VSIX Fixture' })).toBeVisible();
  expect(await savedIdentifiers(page)).toEqual(['writing-room-tests.vsix-sample']);
});
