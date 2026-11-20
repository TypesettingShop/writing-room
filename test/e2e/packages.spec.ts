import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  blockStorage, changeFixtureState, enterLocation, expectFixtureState, failStorageWrites, fixtureOrigin, installedKey,
  installStateFixture, packageFolders, prepareLocationInstall, runCommand, savedIdentifiers, savedRecords, sessionOnlyNotice,
  watchExtensionFailures,
} from './packages.helpers.js';

test('two tabs that install different extensions at once both keep their records', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  // The second tab hears no storage events, as if the first tab's write had not reached its cache yet.
  await second.addInitScript(() => window.addEventListener('storage', event => event.stopImmediatePropagation(), true));
  await first.goto('/');
  await second.goto('/');
  await prepareLocationInstall(first, 'remote');
  await prepareLocationInstall(second, 'oversize-entry');

  await Promise.all([
    first.getByRole('option', { name: /Install Remote Fixture/ }).click(),
    second.getByRole('option', { name: /Install Remote Fixture/ }).click(),
  ]);
  const both = ['writing-room-tests.oversize-entry', 'writing-room-tests.remote'];
  await expect.poll(() => savedIdentifiers(first)).toEqual(both);

  // Installing one after the other, the second tab still reads the first tab's record before it writes.
  await runCommand(first, 'Uninstall Extension', /^Uninstall Extension/);
  await first.getByRole('option', { name: /Remote Fixture.*writing-room-tests\.remote/ }).click();
  await expect.poll(() => savedIdentifiers(first)).toEqual(['writing-room-tests.oversize-entry']);
  await prepareLocationInstall(first, 'remote');
  await first.getByRole('option', { name: /Install Remote Fixture/ }).click();
  await expect.poll(() => savedIdentifiers(first)).toEqual(both);
  await runCommand(second, 'Uninstall Extension', /^Uninstall Extension/);
  await second.getByRole('option', { name: /Remote Fixture.*writing-room-tests\.oversize-entry/ }).click();
  await expect.poll(() => savedIdentifiers(second)).toEqual(['writing-room-tests.remote']);
});

test('a folder URL install saved by v0.1.0 survives the schema 2 migration and still runs', async ({ page }) => {
  const manifest = await (await fetch(fixtureOrigin + '/remote/package.json')).json() as { version: string };
  await page.addInitScript(({ key, record }) => {
    if (!localStorage.getItem('writing-room:storage:version')) {
      localStorage.setItem('writing-room:storage:version', '1');
      localStorage.setItem(key, JSON.stringify([record]));
    }
  }, {
    key: installedKey,
    record: { identifier: 'writing-room-tests.remote', location: fixtureOrigin + '/remote/', manifest, installedAt: 1 },
  });
  await page.goto('/');
  await expect(page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'Remote Fixture' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('writing-room:storage:version'))).toBe('2');
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.remote', location: fixtureOrigin + '/remote/', source: 'location', version: manifest.version,
  })]);
  await runCommand(page, 'Run Remote Fixture', /Run Remote Fixture/);
  await expect(page.getByText('Cross-origin extension ran.')).toBeVisible();
});

const activityBar = (page: Page) => page.locator('[id="workbench.parts.activitybar"]');
const remoteChoice = (page: Page) => page.getByRole('option', { name: /^Install Remote Fixture/ });
const vsixChoice = (page: Page) => page.getByRole('option', { name: /^Install VSIX Fixture .*writing-room-tests\.vsix-sample/ });

async function uninstall(page: Page, name: RegExp): Promise<void> {
  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  await page.getByRole('option', { name }).click();
}

test('in a window that blocks site data, extensions run, install and uninstall for the session only', async ({ page }) => {
  const failures = watchExtensionFailures(page);
  await blockStorage(page);
  await page.goto('/');

  // The built-in extension activates although the machine id lock is denied.
  await runCommand(page, 'Hello World: Say Hello', /Hello World: Say Hello/);
  await expect(page.getByRole('status').filter({ hasText: 'Hello from the extension host!' })).toBeVisible();

  await prepareLocationInstall(page, 'remote');
  await expect(remoteChoice(page)).toContainText(sessionOnlyNotice);
  await remoteChoice(page).click();
  const remote = activityBar(page).getByRole('button', { name: 'Remote Fixture' });
  await expect(remote).toBeVisible();
  await runCommand(page, 'Run Remote Fixture', /Run Remote Fixture/);
  await expect(page.getByText('Cross-origin extension ran.')).toBeVisible();

  await enterLocation(page, fixtureOrigin + '/vsix/sample.vsix');
  await expect(vsixChoice(page)).toContainText(sessionOnlyNotice);
  await vsixChoice(page).click();
  const vsix = activityBar(page).getByRole('button', { name: 'VSIX Fixture' });
  await expect(vsix).toBeVisible();
  await runCommand(page, 'Run VSIX Fixture', /Run VSIX Fixture/);
  await expect(page.getByText('VSIX extension ran.')).toBeVisible();

  await uninstall(page, /Remote Fixture.*writing-room-tests\.remote/);
  await expect(remote).toHaveCount(0);
  await uninstall(page, /VSIX Fixture.*writing-room-tests\.vsix-sample/);
  await expect(vsix).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Could not uninstall extension' })).toHaveCount(0);

  // What was removed installs again in the same session.
  await prepareLocationInstall(page, 'remote');
  await remoteChoice(page).click();
  await expect(remote).toBeVisible();
  await enterLocation(page, fixtureOrigin + '/vsix/sample.vsix');
  await vsixChoice(page).click();
  await expect(vsix).toBeVisible();
  await runCommand(page, 'Run VSIX Fixture', /Run VSIX Fixture/);
  await expect(page.getByText('VSIX extension ran.').first()).toBeVisible();

  await page.reload();
  await expect(activityBar(page).getByRole('button', { name: 'Hello World' })).toBeVisible();
  await expect(remote).toHaveCount(0);
  await expect(vsix).toHaveCount(0);
  await runCommand(page, 'Hello World: Say Hello', /Hello World: Say Hello/);
  await expect(page.getByRole('status').filter({ hasText: 'Hello from the extension host!' })).toBeVisible();
  expect(failures).toEqual([]);
});

test('in a tab whose storage alone fell back, a folder URL installs for the session and a package is refused first', async ({ page }) => {
  const failures = watchExtensionFailures(page);
  await blockStorage(page, { storageOnly: true });
  await page.goto('/');

  await prepareLocationInstall(page, 'remote');
  await expect(remoteChoice(page)).toContainText(sessionOnlyNotice);
  await remoteChoice(page).click();
  await expect(activityBar(page).getByRole('button', { name: 'Remote Fixture' })).toBeVisible();

  await enterLocation(page, fixtureOrigin + '/vsix/sample.vsix');
  await expect(page.getByRole('combobox', { name: 'Could not install extension' })).toBeVisible();
  await expect(page.getByRole('option', { name: /^OK / })).toContainText('Reload the page and try again.');
  await expect(vsixChoice(page)).toHaveCount(0);
  expect(await packageFolders(page)).toEqual([]);
  expect(failures.filter(failure => failure.startsWith('pageerror'))).toEqual([]);
});

test('a window that keeps storage shows no session notice in either confirmation', async ({ page }) => {
  await page.goto('/');
  await prepareLocationInstall(page, 'remote');
  await expect(remoteChoice(page)).toContainText(fixtureOrigin);
  await expect(remoteChoice(page)).not.toContainText(sessionOnlyNotice);
  await page.getByRole('option', { name: 'Cancel' }).click();
  await enterLocation(page, fixtureOrigin + '/vsix/sample.vsix');
  await expect(vsixChoice(page)).toContainText('Source: ' + fixtureOrigin + '/vsix/sample.vsix');
  await expect(vsixChoice(page)).not.toContainText(sessionOnlyNotice);
});

test('a window that blocks site data can write, read and clear an installed extension’s state', async ({ page }) => {
  const failures = watchExtensionFailures(page);
  await blockStorage(page);
  await page.goto('/');
  await installStateFixture(page);
  await expectFixtureState(page, 'initial');
  await changeFixtureState(page);
  await expectFixtureState(page, 'changed');

  await uninstall(page, /State Storage Fixture.*writing-room-tests\.state-storage/);
  await expect(page.getByRole('combobox', { name: 'Could not uninstall extension' })).toHaveCount(0);
  // Installation waits for the pending removal and refuses if its record is still present.
  await installStateFixture(page);
  await expectFixtureState(page, 'initial');
  expect(failures).toEqual([]);
});

test('a tab with blocked localStorage can write and read an installed extension’s state', async ({ page }) => {
  const failures = watchExtensionFailures(page);
  await blockStorage(page, { storageOnly: true });
  await page.goto('/');
  await installStateFixture(page);
  await expectFixtureState(page, 'initial');
  await changeFixtureState(page);
  await expectFixtureState(page, 'changed');
  expect(failures).toEqual([]);
});

test('a tab that falls back after a localStorage write fails can activate and save extension state', async ({ page }) => {
  const failures = watchExtensionFailures(page);
  await page.goto('/');
  await expect(activityBar(page).getByRole('button', { name: 'Hello World' })).toBeVisible();
  await Promise.all([
    page.waitForEvent('console', {
      predicate: event => event.type() === 'warning' && event.text().startsWith('Workbench storage switched to memory.'),
      timeout: 15_000,
    }),
    (async () => {
      await failStorageWrites(page);
      // Running a command adds a new command palette history entry.
      await runCommand(page, 'Hello World: Say Hello', /Hello World: Say Hello/);
    })(),
  ]);

  await installStateFixture(page);
  await expectFixtureState(page, 'initial');
  await changeFixtureState(page);
  await expectFixtureState(page, 'changed');
  expect(failures).toEqual([]);
});
