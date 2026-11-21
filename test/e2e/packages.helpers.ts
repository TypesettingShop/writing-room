import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FILE_DATABASE_NAME, FILE_DATABASE_VERSION } from '../../src/platform/files/browser/indexedDBFileSystemProvider.js';

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
  return page.evaluate(async databaseName => {
    const database = await new Promise<IDBDatabase | undefined>(resolve => {
      const request = indexedDB.open(databaseName);
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
  }, FILE_DATABASE_NAME);
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
export const installLifetimeChangedError = 'Browser storage became unavailable after the confirmation, so the extension was not installed.'
  + ' Install it again to keep it for this session only.';

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

/**
 * Makes `localStorage.setItem` throw a quota error from now on, as in a tab that ran out of quota. Reads, removals,
 * IndexedDB and Web Locks keep working, so a removal from the persisted backend is not refused.
 */
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

/**
 * Counts, from now on, how often a quick input titled `title` opens. A failure prompt that the next command replaces
 * at once still counts; a locator checked after that command would miss it.
 */
export async function countPrompts(page: Page, title: string): Promise<() => Promise<number>> {
  const key = 'test.prompts:' + title;
  await page.evaluate(({ key, title }) => {
    const counts = globalThis as unknown as Record<string, number>;
    counts[key] = 0;
    let open = false;
    new MutationObserver(() => {
      const shown = [...document.querySelectorAll('[role="combobox"]')].some(box => box.getAttribute('aria-label') === title);
      if (shown && !open) {
        counts[key]++;
      }
      open = shown;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
  }, { key, title });
  return () => page.evaluate(key => (globalThis as unknown as Record<string, number>)[key], key);
}

async function expectStateToast(page: Page, message: string, name: string | RegExp = message): Promise<void> {
  const toast = page.getByRole('region', { name, exact: true });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveAccessibleName(message);
  await toast.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(toast).toHaveCount(0);
}

/** `failures` comes from `watchExtensionFailures`. */
export async function installStateFixture(page: Page, failures: readonly string[]): Promise<void> {
  await prepareLocationInstall(page, 'packages/state');
  const install = page.getByRole('option', { name: /^Install State Storage Fixture/ });
  await expect(install).toContainText(sessionOnlyNotice);
  await install.click();
  try {
    await expectStateToast(page, 'State Storage Fixture activated');
  } catch (error) {
    // A refused state write fails the activation. Report why, not only that the toast never came.
    expect(failures).toEqual([]);
    throw error;
  }
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

/** Change the database version from a second document on this origin. */
export async function upgradeFileDatabase(page: Page): Promise<void> {
  const other = await page.context().newPage();
  try {
    await other.route('**/storage-version-test', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Storage version test</title>',
    }));
    await other.goto(new URL('/storage-version-test', page.url()).href);
    await other.evaluate(({ name, version }) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The workbench has not released its old file database connection.'));
    }), { name: FILE_DATABASE_NAME, version: FILE_DATABASE_VERSION + 1 });
  } finally {
    await other.close();
  }
}

/** Flushes workbench state without closing the open confirmation. */
export async function fallBackWhileConfirming(page: Page): Promise<void> {
  const warning = page.waitForEvent('console', {
    predicate: event => event.type() === 'warning' && event.text().startsWith('Workbench storage switched to memory.'),
    timeout: 15_000,
  });
  await failStorageWrites(page);
  const flush = page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
  await Promise.all([warning, flush]);
}
