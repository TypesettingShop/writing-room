import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import {
  blockStorage, enterLocation, fixtureOrigin, installedKey, runCommand, savedIdentifiers, savedRecords, sessionOnlyNotice,
} from './packages.helpers.js';
import {
  fallBackAfterOneWrite, installFolder, openRestorablePanel, restartHost, restoreOwner, savedStates, saveLayout, schemaKey,
  startHost, stateKey, stateText, uninstallExtension, watchStateWarnings, webviewContent,
} from './webview-state.helpers.js';
import restoreManifest from '../fixtures/extensions/webview/restore/package.json' with { type: 'json' };

const restoreLocation = new URL('restore/', extensionFixtureLocation('webview')).href;
const restoreChoice = /^Install Webview Restore Fixture/;
const vsixOwner = 'writing-room-tests.vsix-sample';

async function incrementPanel(page: Page, expectedCount: string): Promise<void> {
  const content = webviewContent(page);
  await content.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(content.locator('#counter')).toHaveText(expectedCount);
}

async function expectRestoredPanel(page: Page, count: string): Promise<void> {
  const content = webviewContent(page);
  await expect(content.getByText('Restored 1', { exact: true })).toBeVisible();
  await expect(content.locator('#serializer')).toHaveText(count);
  await expect(content.locator('#counter')).toHaveText(count);
}

for (const scenario of ['blocked site storage', 'blocked workbench storage', 'newer storage schema'] as const) {
  test('restores the panel in the same tab with ' + scenario, async ({ page }) => {
    const futureStates = JSON.stringify([{ id: 'future', extension: 'fixture.future', state: '42' }]);
    if (scenario === 'newer storage schema') {
      await page.addInitScript(({ schemaKey, stateKey, futureStates }) => {
        if (window.top === window) {
          localStorage.setItem(schemaKey, '3');
          localStorage.setItem(stateKey, futureStates);
        }
      }, { schemaKey, stateKey, futureStates });
    } else {
      await blockStorage(page, { storageOnly: scenario === 'blocked workbench storage' });
    }
    const warnings = watchStateWarnings(page);
    await page.goto('/');
    await installFolder(page, 'webview/restore', restoreChoice, sessionOnlyNotice);
    await openRestorablePanel(page);
    await incrementPanel(page, '1');
    await incrementPanel(page, '2');
    await restartHost(page);
    await expectRestoredPanel(page, '2');
    expect(warnings).toEqual([]);
    if (scenario === 'newer storage schema') {
      expect(await page.evaluate(key => localStorage.getItem(key), schemaKey)).toBe('3');
      expect(await stateText(page)).toBe(futureStates);
    }
  });
}

test('a WebviewView re-resolves with the state saved in its memory-mode tab', async ({ page }) => {
  await blockStorage(page);
  const warnings = watchStateWarnings(page);
  await page.goto('/');
  await installFolder(page, 'webview/view', /^Install Webview View Fixture/, sessionOnlyNotice);
  await page.getByRole('button', { name: 'Webview View Fixture', exact: true }).click();
  const content = webviewContent(page);
  await expect(content.locator('#state')).toHaveText('-');
  await content.getByRole('button', { name: 'Increment view' }).click();
  await expect(content.locator('#count')).toHaveText('1');

  await restartHost(page);
  await expect(content.locator('#state')).toHaveText('1');
  await expect(content.locator('#count')).toHaveText('1');
  expect(warnings).toEqual([]);
});

for (const action of ['closing the panel', 'uninstalling its extension'] as const) {
  test('keeps the saved panel state when ' + action + ' in a tab that fell back', async ({ page }) => {
    await seedInstalledExtensions(page, [{ location: restoreLocation, manifest: restoreManifest }]);
    await page.goto('/');
    await openRestorablePanel(page);
    await incrementPanel(page, '1');
    await expect.poll(() => savedStates(page)).toEqual([
      expect.objectContaining({ extension: restoreOwner, state: '{"count":1}' }),
    ]);
    const persisted = await stateText(page);
    await saveLayout(page);
    await page.reload();
    await expectRestoredPanel(page, '1');

    await fallBackAfterOneWrite(page);
    await incrementPanel(page, '2');
    await restartHost(page);
    await expectRestoredPanel(page, '2');
    expect(await stateText(page)).toBe(persisted);
    if (action === 'closing the panel') {
      await page.getByRole('button', { name: 'Close Restorable', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'Restorable' })).toHaveCount(0);
    } else {
      await uninstallExtension(page, restoreOwner);
      // The contributions go once the host has deactivated the extension (wr-eycu.4bd), and the palette lists what
      // was contributed when it opened, so it opens again until the command is gone.
      await expect.poll(async () => {
        await page.keyboard.press('F1');
        await page.getByRole('combobox').fill('Fixture: Open Restorable Webview');
        const count = await page.getByRole('option', { name: 'Fixture: Open Restorable Webview', exact: true }).count();
        await page.keyboard.press('Escape');
        return count;
      }).toBe(0);
      expect(await savedIdentifiers(page)).toContain(restoreOwner);
    }
    expect(await stateText(page)).toBe(persisted);

    await page.reload();
    await expectRestoredPanel(page, '1');
  });
}

test('an early tab installing another extension keeps the state of an extension installed by a second tab', async ({ page, context }) => {
  await page.goto('/');
  await startHost(page);
  await page.evaluate(key => {
    window.addEventListener('storage', event => {
      if (event.key === key && event.newValue) {
        document.documentElement.dataset.savedWebviewState = event.newValue;
      }
    });
  }, stateKey);

  const second = await context.newPage();
  await second.goto('/');
  await installFolder(second, 'webview/restore', restoreChoice);
  await expect.poll(() => savedIdentifiers(second)).toContain(restoreOwner);
  await openRestorablePanel(second);
  await incrementPanel(second, '1');
  await expect.poll(() => savedStates(second)).toEqual([
    expect.objectContaining({ extension: restoreOwner, state: '{"count":1}' }),
  ]);
  const persisted = await stateText(second);
  await expect(page.locator('html')).toHaveAttribute('data-saved-webview-state', persisted!);
  await page.bringToFront();
  await installFolder(page, 'remote', /^Install Remote Fixture/);
  await expect.poll(() => savedIdentifiers(page)).toEqual(['writing-room-tests.remote', restoreOwner]);
  expect(await stateText(second)).toBe(persisted);
});

test('reinstalling a package preserves its recorded Webview state until uninstall commits', async ({ page }) => {
  await page.goto('/');
  const location = fixtureOrigin + '/vsix/sample.vsix';
  const container = page.getByRole('button', { name: 'VSIX Fixture', exact: true });
  await enterLocation(page, location);
  await page.getByRole('option', { name: /^Install VSIX Fixture/ }).click();
  await expect(container).toBeVisible();

  // The sample package has no Webview command. Seed a state owned by its installed record.
  const persisted = JSON.stringify([{ id: 'fixture-panel', extension: vsixOwner, state: '{"count":3}' }]);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: stateKey, value: persisted });
  await page.reload();
  await runCommand(page, 'Run VSIX Fixture', /^Run VSIX Fixture$/);
  await expect(page.getByText('VSIX extension ran.')).toBeVisible();
  expect(await stateText(page)).toBe(persisted);

  const previous = (await savedRecords(page)).find(record => record.identifier === vsixOwner);
  await enterLocation(page, location);
  await page.getByRole('option', { name: /^Reinstall VSIX Fixture/ }).click();
  await expect.poll(async () => {
    const reinstalled = (await savedRecords(page)).find(record => record.identifier === vsixOwner);
    return typeof reinstalled?.installedAt === 'number' && reinstalled.installedAt !== previous?.installedAt;
  }).toBe(true);
  await expect(container).toBeVisible();
  expect(await stateText(page)).toBe(persisted);

  await uninstallExtension(page, vsixOwner);
  await expect.poll(() => savedIdentifiers(page)).not.toContain(vsixOwner);
  await expect.poll(() => savedStates(page)).toEqual([]);
});

test('reclaims a panel closed during failed uninstall when its owner is registered again', async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: restoreLocation, manifest: restoreManifest }]);
  await page.goto('/');
  await openRestorablePanel(page);
  await incrementPanel(page, '1');
  await expect.poll(() => savedStates(page)).toEqual([
    expect.objectContaining({ extension: restoreOwner, state: '{"count":1}' }),
  ]);

  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, name, value) {
      if (this === window.localStorage && name === key) {
        Storage.prototype.setItem = original;
        throw new DOMException('Could not commit the removal in this test.', 'QuotaExceededError');
      }
      original.call(this, name, value);
    };
  }, installedKey);
  await uninstallExtension(page, restoreOwner);
  await expect(page.getByRole('combobox', { name: 'Could not uninstall extension' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toHaveCount(0);
  expect(await savedIdentifiers(page)).toContain(restoreOwner);
  await expect.poll(() => savedStates(page)).toEqual([]);

  await page.getByRole('option', { name: /^OK / }).click();
  await openRestorablePanel(page);
  await expect(webviewContent(page).locator('#counter')).toHaveText('0');
});
