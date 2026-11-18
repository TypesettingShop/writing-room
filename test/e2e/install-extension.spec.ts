import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const fixtureOrigin = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT;
const storageKey = 'writing-room:storage:0:extensions.user';
const installed = (page: Page) => page.evaluate(key => localStorage.getItem(key), storageKey);

async function runCommand(page: Page, query: string, name: RegExp): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option', { name }).click();
}

async function prepareInstall(page: Page, path: string): Promise<void> {
  await runCommand(page, 'Install Extension from Location', /Install Extension from Location/);
  const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await location.fill(fixtureOrigin + '/' + path);
  await location.press('Enter');
}

async function install(page: Page, path: string): Promise<void> {
  await prepareInstall(page, path);
  await page.getByRole('option', { name: /Install Remote Fixture/ }).click();
}

test('confirms the source, restores its snapshot without requests and removes live contributions', async ({ page }) => {
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.context().on('request', request => {
    if (request.url().startsWith(fixtureOrigin)) {
      requests.push(new URL(request.url()).pathname);
    }
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await prepareInstall(page, 'remote?ignored=1#fragment');
  const choice = page.getByRole('option', { name: /Install Remote Fixture/ });
  await expect(choice).toContainText('writing-room-tests · 1.0.0');
  await expect(choice).toContainText(fixtureOrigin);
  expect(await installed(page)).toBeNull();
  expect(requests).toEqual(['/remote/package.json']);
  await page.getByRole('option', { name: 'Cancel' }).click();
  expect(await installed(page)).toBeNull();
  await install(page, 'remote');
  const container = page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'Remote Fixture' });
  await expect(container).toBeVisible();
  expect(JSON.parse((await installed(page))!)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.remote', location: fixtureOrigin + '/remote/',
  })]);
  await expect(container.locator('.codicon-extensions')).toBeVisible();
  expect(requests).toEqual(['/remote/package.json', '/remote/package.json']);

  requests.length = 0;
  await page.reload();
  await expect(container).toBeVisible();
  expect(requests).toEqual([]);
  await runCommand(page, 'Run Remote Fixture', /Run Remote Fixture/);
  await expect(page.getByText('Cross-origin extension ran.')).toBeVisible();
  await expect(page.getByText('Remote fixture active')).toBeVisible();
  await expect(container.locator('.wr-deferred-icon')).toHaveCSS('background-image', /url\("blob:/);
  expect(requests).toEqual(expect.arrayContaining(['/remote/extension.js', '/remote/icon.png']));
  await page.getByRole('button', { name: 'OK', exact: true }).click();

  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  await page.getByRole('option', { name: /Remote Fixture/ }).click();
  await expect(container).toHaveCount(0);
  await expect(page.getByText('Remote fixture active')).toHaveCount(0);
  expect(await installed(page)).toBeNull();
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Run Remote Fixture');
  await expect(page.getByRole('option', { name: /Run Remote Fixture/ })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

for (const [path, reason] of [
  ['no-cors', /does not allow|may not allow cross-origin/],
  ['redirect', /require a redirect/],
  ['oversize', /exceeds 262144 bytes/],
] as const) {
  test('shows a diagnostic and writes nothing for ' + path, async ({ page }) => {
    await page.goto('/');
    await prepareInstall(page, path);
    await expect(page.getByRole('combobox', { name: 'Could not install extension' })).toBeVisible();
    await expect(page.getByRole('option', { name: /^OK / })).toContainText(reason);
    expect(await installed(page)).toBeNull();
    await expect(page.getByRole('button', { name: 'Remote Fixture' })).toHaveCount(0);
  });
}

test('keeps saved contributions when code is unavailable or larger than 5 MiB', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); } });
  await page.goto('/');
  await install(page, 'remote');
  await page.context().route(fixtureOrigin + '/remote/extension.js', route => route.abort());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remote Fixture' })).toBeVisible();
  await runCommand(page, 'Run Remote Fixture', /Run Remote Fixture/);
  await expect.poll(() => consoleErrors.join(' ')).toContain("command 'fixture.remote.hello' not found");
  expect(await installed(page)).toContain('writing-room-tests.remote');
  await expect(page.getByRole('button', { name: 'Remote Fixture' })).toBeVisible();

  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  await page.getByRole('option', { name: /Remote Fixture/ }).click();
  await expect(page.getByRole('button', { name: 'Remote Fixture' })).toHaveCount(0);
  await install(page, 'oversize-entry');
  await expect(page.getByRole('button', { name: 'Remote Fixture' })).toBeVisible();
  await expect.poll(() => consoleErrors.join(' ')).toContain('Response exceeds 5242880 bytes');
  await expect(page.getByText('Remote fixture active')).toHaveCount(0);
  expect(await installed(page)).toContain('writing-room-tests.oversize-entry');
});
