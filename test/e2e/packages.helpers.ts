import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const fixtureOrigin = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT;
export const installedKey = 'writing-room:storage:0:extensions.user';

export async function runCommand(page: Page, query: string, name: RegExp): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option', { name }).click();
}

/** The installed records as saved, read from storage rather than from the workbench. */
export async function savedRecords(page: Page): Promise<Record<string, unknown>[]> {
  const text = await page.evaluate(key => localStorage.getItem(key), installedKey);
  return text === null ? [] : JSON.parse(text) as Record<string, unknown>[];
}

export async function savedIdentifiers(page: Page): Promise<string[]> {
  return (await savedRecords(page)).map(record => String(record.identifier)).sort();
}

/** The paths under `/extensions/` in the user data store, read straight from IndexedDB. */
export async function packageFolders(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase | undefined>(resolve => {
      const request = indexedDB.open('writing-room-files');
      request.onupgradeneeded = () => { request.transaction?.abort(); resolve(undefined); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
    if (!database) {
      return [];
    }
    try {
      if (!database.objectStoreNames.contains('vscode-userdata')) {
        return [];
      }
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction('vscode-userdata').objectStore('vscode-userdata').getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return keys.map(String).filter(key => key.startsWith('/extensions/')).sort();
    } finally {
      database.close();
    }
  });
}

/** Runs Install Extension from Location with `url`. */
export async function enterLocation(page: Page, url: string): Promise<void> {
  await runCommand(page, 'Install Extension from Location', /Install Extension from Location/);
  const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await location.fill(url);
  await location.press('Enter');
}

/** Opens the folder URL install up to its confirmation. */
export async function prepareLocationInstall(page: Page, path: string): Promise<void> {
  await enterLocation(page, fixtureOrigin + '/' + path);
  await expect(page.getByRole('option', { name: 'Cancel' })).toBeVisible();
}

export const sessionOnlyNotice = 'Browser storage is unavailable: the extension stays for this session only.';

/**
 * Makes the page act like a browser that blocks site data, from the next navigation on: reading the
 * `localStorage` property throws, `indexedDB.open` fails and Web Locks requests are denied without calling back.
 * With `storageOnly`, only `localStorage` is blocked, as in a tab whose workbench storage alone fell back.
 * Blocking `localStorage` alone misses the first failure of a real blocked window, the denied lock.
 */
export async function blockStorage(page: Page, { storageOnly = false } = {}): Promise<void> {
  await page.addInitScript(storageOnly => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Failed to read the \'localStorage\' property from \'Window\': Access is denied for this document.', 'SecurityError');
      },
    });
    if (!storageOnly) {
      IDBFactory.prototype.open = () => {
        throw new DOMException('The user denied permission to access the database.', 'UnknownError');
      };
      LockManager.prototype.request = () => Promise.reject(new DOMException('The request was denied.', 'SecurityError'));
    }
  }, storageOnly);
}

/** Fails localStorage writes from now on, leaving reads, IndexedDB and Web Locks available. */
export async function failStorageWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key, value) {
      if (this === window.localStorage) {
        throw new DOMException('Test blocked localStorage writes.', 'QuotaExceededError');
      }
      setItem.call(this, key, value);
    };
  });
}

/** Collects the page errors and the console messages that say an extension did not activate. */
export function watchExtensionFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push('pageerror: ' + error.message));
  page.on('console', message => {
    // Install and uninstall failures are quick pick titles, not console messages; the tests look for those.
    if (/Could not activate/.test(message.text())) {
      failures.push(message.text());
    }
  });
  return failures;
}

async function expectStateToast(page: Page, message: string, name: string | RegExp = message): Promise<void> {
  const toast = page.getByRole('region', { name, exact: true });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveAccessibleName(message);
  await toast.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(toast).toHaveCount(0);
}

export async function installStateFixture(page: Page): Promise<void> {
  await prepareLocationInstall(page, 'packages/state');
  const install = page.getByRole('option', { name: /^Install State Storage Fixture/ });
  await expect(install).toContainText(sessionOnlyNotice);
  await install.click();
  await expectStateToast(page, 'State Storage Fixture activated');
  await expect(page.getByRole('combobox', { name: 'Could not install extension' })).toHaveCount(0);
}

export async function expectFixtureState(page: Page, state: 'initial' | 'changed'): Promise<void> {
  await runCommand(page, 'Read State Storage Fixture', /^Read State Storage Fixture$/);
  await expectStateToast(page, `State Storage Fixture read global ${state} and workspace ${state}`, /^State Storage Fixture read /);
}

export async function changeFixtureState(page: Page): Promise<void> {
  await runCommand(page, 'Change State Storage Fixture', /^Change State Storage Fixture$/);
  await expectStateToast(page, 'State Storage Fixture changed both values');
}
