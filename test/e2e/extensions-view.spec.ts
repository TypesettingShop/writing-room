import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { enterLocation, fixtureOrigin, packageFolders, runCommand, savedRecords } from './packages.helpers.js';

const hosts = ['open-vsx.org', 'openvsx.eclipsecontent.org', 'wrong.example'];
const galleryRequest = (url: URL) => hosts.includes(url.hostname);
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search Open VSX' });
const installed = (page: Page) => page.getByRole('list', { name: 'Installed extensions' });
const results = (page: Page) => page.getByRole('list', { name: 'Open VSX search results' });
const installButton = (page: Page, variant: string) => results(page).getByRole('button', { name: 'Install Gallery ' + variant });
const confirmation = (page: Page, variant: string, action = 'Install') =>
  page.getByRole('option', { name: new RegExp('^' + action + ' Gallery ' + variant) });

async function respondFromFixture(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const response = await route.fetch({ url: fixtureOrigin + '/gallery' + url.pathname + url.search, maxRedirects: 0 });
  const location = response.headers()['location'];
  if (response.status() !== 302 || !location) {
    await route.fulfill({ response });
    return;
  }
  const target = new URL(location);
  const content = fixtureOrigin + '/gallery' + target.pathname;
  if (target.hostname === 'wrong.example') {
    // Browser routing intercepts only the first hop. The unapproved host is our real local fixture server.
    await route.fulfill({ response, headers: { ...response.headers(), location: content } });
  } else {
    await route.fulfill({ response: await route.fetch({ url: content }) });
  }
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+Shift+x');
  await expect(search(page)).toBeFocused();
}

async function seek(page: Page, variant: string): Promise<void> {
  await search(page).fill('gallery-' + variant);
  await expect(installButton(page, variant)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route(galleryRequest, respondFromFixture);
});

test('installs the verified bytes by keyboard, persists them, runs the command, and uninstalls', async ({ page }) => {
  await open(page);
  await seek(page, 'signed');
  const row = results(page).getByRole('listitem').filter({ hasText: 'Gallery signed' });
  await expect(row).toContainText('writing-room-tests (verified publisher) · 1.1.0 · 17 downloads');
  await expect(row.getByText('<span data-gallery-fixture>Fixture text</span>', { exact: true })).toBeVisible();
  await expect(row.locator('[data-gallery-fixture]')).toHaveCount(0);
  await expect(row.locator('.codicon-extensions')).toBeVisible();
  await expect(row.locator('img')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(installButton(page, 'signed')).toBeFocused();
  await page.keyboard.press('Enter');

  const choice = confirmation(page, 'signed');
  await expect(choice).toContainText('writing-room-tests · 1.1.0 · writing-room-tests.gallery-signed');
  await expect(choice).toContainText('License: MIT');
  await expect(choice).toContainText('Source: open-vsx.org');
  await expect(choice).toContainText('Download host: open-vsx.org');
  await expect(choice).toContainText('The key comes from open-vsx.org');
  await expect(choice).toContainText(/Size: \d+ bytes.*SHA-256: [0-9a-f]{64}.*Signature: verified \(gallery-test\)/);
  await expect(choice).toContainText('compromised registry');
  await expect(choice).toContainText('Web extension');
  expect(await savedRecords(page)).toEqual([]);
  expect(await packageFolders(page)).toEqual([]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const uninstall = installed(page).getByRole('button', { name: 'Uninstall Gallery signed' });
  await expect(uninstall).toBeVisible();
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.gallery-signed', version: '1.1.0', source: 'gallery', signature: 'verified',
    galleryUrl: expect.stringContaining('https://open-vsx.org/api/'), packageSha256: expect.stringMatching(/^[a-f\d]{64}$/),
  })]);
  expect(await packageFolders(page)).toContain('/extensions/writing-room-tests.gallery-signed-1.1.0');

  await page.route(galleryRequest, route => route.abort());
  await page.reload();
  await expect(search(page)).toBeVisible();
  await expect(uninstall).toBeVisible();
  await expect(installed(page).getByText(/gallery-signed · 1.1.0 · Open VSX/)).toBeVisible();
  await runCommand(page, 'Run Gallery signed', /Run Gallery signed/);
  await expect(page.getByText('Ran writing-room-tests.gallery-signed')).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await uninstall.click();
  await expect(uninstall).toHaveCount(0);
  await expect.poll(() => savedRecords(page)).toEqual([]);
  await expect.poll(() => packageFolders(page)).toEqual([]);
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Run Gallery signed');
  await expect(page.getByRole('option', { name: /Run Gallery signed/ })).toHaveCount(0);
});

for (const variant of ['unsigned', 'unverifiable']) {
  test('shows the ' + variant + ' warning with Cancel active', async ({ page }) => {
    const target = variant === 'unsigned' ? 'unsigned' : 'signed';
    if (variant === 'unverifiable') {
      await page.addInitScript(() => {
        const importKey = SubtleCrypto.prototype.importKey;
        SubtleCrypto.prototype.importKey = function (this: SubtleCrypto, ...args: Parameters<typeof importKey>) {
          if (args[2] === 'Ed25519') {
            return Promise.reject(new DOMException('Ed25519 unavailable', 'NotSupportedError'));
          }
          return importKey.apply(this, args);
        } as typeof importKey;
      });
    }
    await open(page);
    await seek(page, target);
    await installButton(page, target).click();
    const title = variant === 'unsigned' ? 'Warning: This package has no signature.'
      : 'Warning: This browser could not verify the Ed25519 signature.';
    await expect(page.getByRole('combobox', { name: title, exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: title, exact: true })).toHaveCount(0);
    await expect(installButton(page, target)).toBeVisible();
    expect(await savedRecords(page)).toEqual([]);
    expect(await packageFolders(page)).toEqual([]);
    await installButton(page, target).click();
    await confirmation(page, target).click();
    await expect(installed(page).getByRole('button', { name: 'Uninstall Gallery ' + target })).toBeVisible();
    expect(await savedRecords(page)).toEqual([expect.objectContaining({ source: 'gallery', signature: variant })]);
  });
}

for (const [variant, reason] of [
  ['bad-hash', /SHA-256 checksum does not match/],
  ['bad-signature', /Ed25519 signature does not match/],
  ['bad-host', /unapproved host or protocol/],
  ['oversize', /exceeds the 50 MiB download limit/],
  ['node-metadata', /not a web extension/],
  ['node-package', /downloaded package is not a web extension/],
  ['pack', /extension packs are not supported/],
] as const) {
  test('rejects ' + variant + ' and keeps the failure on the result row', async ({ page }) => {
    await open(page);
    await seek(page, variant);
    await installButton(page, variant).click();
    await expect(results(page).getByText(reason)).toBeVisible();
    await expect(results(page).getByRole('button', { name: 'Retry Gallery ' + variant })).toBeVisible();
    expect(await savedRecords(page)).toEqual([]);
    expect(await packageFolders(page)).toEqual([]);
  });
}

test('retry makes another request and can recover, with only one in-flight install per identity', async ({ page }) => {
  let invalid = true;
  let downloads = 0;
  await page.route(/open-vsx\.org.*gallery-signed.*package\.vsix/, async route => {
    downloads++;
    await respondFromFixture(route);
  });
  await page.route(/open-vsx\.org.*gallery-signed.*package\.sha256/, async route => {
    if (invalid) {
      await route.fulfill({ body: '0'.repeat(64), headers: { 'Access-Control-Allow-Origin': '*' } });
    } else {
      await respondFromFixture(route);
    }
  });
  await open(page);
  await seek(page, 'signed');
  await installButton(page, 'signed').evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(results(page).getByText(/SHA-256 checksum does not match/)).toBeVisible();
  expect(downloads).toBe(1);
  invalid = false;
  await results(page).getByRole('button', { name: 'Retry Gallery signed' }).click();
  await confirmation(page, 'signed').click();
  await expect(installed(page).getByRole('button', { name: 'Uninstall Gallery signed' })).toBeVisible();
  expect(downloads).toBe(2);
});

test('cancels a pending download, leaves no package, and unlocks Install', async ({ page }) => {
  const packageUrl = /open-vsx\.org.*gallery-slow.*package\.vsix/;
  let release!: () => void;
  const sent = new Promise<void>(resolve => { release = resolve; });
  await page.route(packageUrl, async route => {
    await sent;
    await route.abort().catch(() => {});
  });
  try {
    await open(page);
    await seek(page, 'slow');
    const pending = page.waitForRequest(packageUrl);
    await installButton(page, 'slow').click();
    await pending;
    const failed = page.waitForEvent('requestfailed', request => packageUrl.test(request.url()));
    await results(page).getByRole('button', { name: 'Cancel Gallery slow' }).click();
    expect((await failed).failure()?.errorText).toContain('ERR_ABORTED');
    await expect(installButton(page, 'slow')).toBeVisible();
    expect(await savedRecords(page)).toEqual([]);
    expect(await packageFolders(page)).toEqual([]);
  } finally {
    release();
  }
});

test('keeps the installed list live while the gallery is unavailable and when moved to the panel', async ({ page }) => {
  await open(page);
  await enterLocation(page, fixtureOrigin + '/remote');
  await page.getByRole('option', { name: /Install Remote Fixture/ }).click();
  await expect(installed(page).getByRole('button', { name: 'Uninstall Remote Fixture' })).toBeVisible();
  await search(page).fill('unavailable');
  await expect(page.getByText('HTTP 503', { exact: true })).toBeVisible();
  const activity = page.locator('[id="workbench.parts.activitybar"]');
  await activity.getByRole('button', { name: 'Extensions' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Panel' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Extensions' });
  await expect(panel.getByRole('searchbox', { name: 'Search Open VSX' })).toHaveValue('unavailable');
  await expect(panel.getByRole('button', { name: 'Uninstall Remote Fixture' })).toBeVisible();
});

test('reports an exhausted gallery quota and stops sending requests', async ({ page }) => {
  const searches: string[] = [];
  await page.route('https://open-vsx.org/api/-/search?**', async route => {
    searches.push(new URL(route.request().url()).searchParams.get('query') ?? '');
    await respondFromFixture(route);
  });
  await open(page);
  await search(page).fill('rate-limited');
  const message = page.getByText('Open VSX is rate limited. Try again in a minute.', { exact: true });
  await expect(message).toBeVisible();
  await search(page).fill('gallery-unsigned');
  await expect(page.getByRole('button', { name: 'Retry Search' })).toBeVisible();
  await expect(message).toBeVisible();
  expect(searches).toEqual(['rate-limited']);
});

test('confirms missing dependencies individually and installs them first', async ({ page }) => {
  await open(page);
  await seek(page, 'with-dependency');
  const parent = confirmation(page, 'with-dependency');
  await installButton(page, 'with-dependency').click();
  await expect(parent).toContainText('Dependencies: writing-room-tests.gallery-dependency');
  await parent.click();
  const dependency = confirmation(page, 'dependency');
  await expect(dependency).toBeVisible();
  expect(await savedRecords(page)).toEqual([]);
  await dependency.click();
  await expect(installed(page).getByRole('button', { name: 'Uninstall Gallery with-dependency' })).toBeVisible();
  expect((await savedRecords(page)).map(record => record.identifier)).toEqual([
    'writing-room-tests.gallery-dependency', 'writing-room-tests.gallery-with-dependency',
  ]);
});

test('accepts declarative web packages without a browser entry', async ({ page }) => {
  await open(page);
  await seek(page, 'declarative');
  await installButton(page, 'declarative').click();
  const option = confirmation(page, 'declarative');
  await expect(option).toContainText('Web extension');
  await option.click();
  await expect(installed(page).getByRole('button', { name: 'Uninstall Gallery declarative' })).toBeVisible();
});

test('drops a local VSIX, then offers an update only for a newer gallery version', async ({ page }) => {
  await open(page);
  const versionUrl = 'https://open-vsx.org/api/writing-room-tests/gallery-signed/1.0.0/file/package.vsix';
  const response = await fetch(fixtureOrigin + '/gallery' + new URL(versionUrl).pathname, { redirect: 'manual' });
  const path = new URL(response.headers.get('location')!).pathname;
  const file = await fetch(fixtureOrigin + '/gallery' + path);
  const bytes = [...new Uint8Array(await file.arrayBuffer())];
  const payload = await page.evaluateHandle(values => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(values)], 'gallery-signed.vsix'));
    return transfer;
  }, bytes);
  await search(page).dispatchEvent('drop', { dataTransfer: payload });
  await confirmation(page, 'signed').click();
  await expect(installed(page).getByText(/gallery-signed · 1.0.0 · VSIX/)).toBeVisible();
  await search(page).fill('gallery-signed');
  await results(page).getByRole('button', { name: 'Update Gallery signed' }).click();
  await confirmation(page, 'signed', 'Update').click();
  await expect(installed(page).getByText(/gallery-signed · 1.1.0 · Open VSX/)).toBeVisible();
  expect(await packageFolders(page)).not.toContain('/extensions/writing-room-tests.gallery-signed-1.0.0');
  await expect(results(page).getByRole('button', { name: 'Update Gallery signed' })).toHaveCount(0);
});


test('keeps the gallery confirmation open when a palette VSIX download reaches confirmation', async ({ page }) => {
  const url = fixtureOrigin + '/vsix/sample.vsix';
  let finishDownload!: () => void;
  const hold = new Promise<void>(resolve => { finishDownload = resolve; });
  await page.route(url, async route => {
    await hold;
    await route.continue();
  });

  try {
    await open(page);
    await seek(page, 'signed');
    const pending = page.waitForRequest(url);
    await enterLocation(page, url);
    await pending;
    await installButton(page, 'signed').click();
    const first = confirmation(page, 'signed');
    await expect(first).toBeVisible();
    finishDownload();

    await expect(page.getByText('Waiting to confirm VSIX installation…', { exact: true })).toBeVisible();
    await expect(first).toBeVisible();
    const second = page.getByRole('option', { name: /^Install VSIX Fixture/ });
    await expect(second).toHaveCount(0);
    await first.click();
    await expect(second).toBeVisible();
    await second.click();
    await expect.poll(async () => (await savedRecords(page)).map(record => record.source).sort())
      .toEqual(['gallery', 'vsix']);
  } finally {
    finishDownload();
  }
});

test('cancels a queued gallery confirmation while the first prompt remains open', async ({ page }) => {
  await open(page);
  await search(page).fill('gallery-');
  await installButton(page, 'signed').click();
  const first = confirmation(page, 'signed');
  await expect(first).toBeVisible();
  await installButton(page, 'unsigned').click();
  const row = results(page).getByRole('listitem').filter({ hasText: 'Gallery unsigned' });
  await expect(row.getByText('Waiting for confirmation…')).toBeVisible();
  await row.getByRole('button', { name: 'Cancel Gallery unsigned' }).click();

  await expect(installButton(page, 'unsigned')).toBeEnabled();
  await expect(first).toBeVisible();
  await first.click();
  await expect(installed(page).getByRole('button', { name: 'Uninstall Gallery signed' })).toBeVisible();
  await expect(confirmation(page, 'unsigned')).toHaveCount(0);
  expect(await savedRecords(page)).toEqual([expect.objectContaining({ identifier: 'writing-room-tests.gallery-signed' })]);
});

test('reuses an icon that is still present when a search is refined', async ({ page }) => {
  const icon = /open-vsx\.org.*gallery-unsigned.*icon\.svg/;
  const fetches: string[] = [];
  await page.route(icon, async route => {
    fetches.push(route.request().url());
    await respondFromFixture(route);
  });
  await open(page);
  const row = results(page).getByRole('listitem').filter({ hasText: 'Gallery unsigned' });
  await search(page).fill('gallery-unsigne');
  await expect(row.locator('img')).toHaveAttribute('src', /^blob:/);
  await search(page).fill('gallery-unsigned');
  await expect(row.locator('img')).toHaveAttribute('src', /^blob:/);
  expect(fetches).toHaveLength(1);
});
