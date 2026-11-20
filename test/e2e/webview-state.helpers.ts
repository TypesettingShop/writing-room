import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { prepareLocationInstall, runCommand } from './packages.helpers.js';

export const stateKey = 'writing-room:storage:1:webview.states.v1';
export const schemaKey = 'writing-room:storage:version';
export const restoreOwner = 'writing-room-tests.webview-restore';

export const webviewContent = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

export function stateText(page: Page): Promise<string | null> {
  return page.evaluate(key => localStorage.getItem(key), stateKey);
}

export async function savedStates(page: Page): Promise<{ id: string; extension: string; state: string }[]> {
  return JSON.parse((await stateText(page)) ?? '[]');
}

export async function startHost(page: Page): Promise<void> {
  await runCommand(page, 'Hello World: Say Hello', /Hello World: Say Hello/);
  await expect(page.getByRole('status').filter({ hasText: 'Hello from the extension host!' })).toBeVisible();
}

export function openRestorablePanel(page: Page): Promise<void> {
  return runCommand(page, 'Fixture: Open Restorable Webview', /^Fixture: Open Restorable Webview$/);
}

export function restartHost(page: Page): Promise<void> {
  return runCommand(page, 'Restart Extension Host', /^Restart Extension Host$/);
}

export function saveLayout(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
}

export async function installFolder(page: Page, path: string, title: RegExp, notice?: string): Promise<void> {
  await prepareLocationInstall(page, path);
  const choice = page.getByRole('option', { name: title });
  if (notice) {
    await expect(choice).toContainText(notice);
  }
  await choice.click();
}

export async function uninstallExtension(page: Page, owner: string): Promise<void> {
  await runCommand(page, 'Uninstall Extension', /^Uninstall Extension/);
  await page.getByRole('option').filter({ hasText: owner }).click();
}

/** Fail a single workbench write and immediately restore the browser's working backend. */
export async function fallBackAfterOneWrite(page: Page): Promise<void> {
  const warning = page.waitForEvent('console', {
    predicate: event => event.type() === 'warning' && event.text().startsWith('Workbench storage switched to memory.'),
    timeout: 15_000,
  });
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key, value) {
      if (this === window.localStorage && key.startsWith('writing-room:storage:')) {
        Storage.prototype.setItem = setItem;
        throw new DOMException('Test blocked one workbench storage write.', 'QuotaExceededError');
      }
      setItem.call(this, key, value);
    };
  });
  // A fresh command changes the palette history, which is written through the storage queue.
  const toggleSidebar = runCommand(page, 'Toggle Primary Side Bar Visibility', /Toggle Primary Side Bar Visibility/);
  await Promise.all([warning, toggleSidebar]);
}

export function watchStateWarnings(page: Page): readonly string[] {
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().startsWith('Webview state could not be saved.')) {
      warnings.push(message.text());
    }
  });
  return warnings;
}
