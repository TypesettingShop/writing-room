import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect, renderedText } from './fixtures.js';

export const settingsKey = 'writing-room:storage:0:user.settings.json';

const manifest = JSON.parse(readFileSync(
  new URL('../fixtures/extensions/configuration/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

export const settingsTab = (page: Page) => page.getByRole('tab', { name: 'settings.json', exact: true });
export const settingsEditor = (page: Page) => page.locator('[data-group-id]').filter({ has: settingsTab(page) }).first();
export const activeEditor = (page: Page) => page.locator('[data-group-id].active').getByRole('textbox', { name: 'Editor content' });
export const diagnostics = (page: Page) => settingsEditor(page).locator('.squiggly-warning, .squiggly-error');

/** Installs the configuration fixture before the workbench starts, then opens the app. */
export async function openWithConfigurationFixture(page: Page): Promise<void> {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('configuration'), manifest }]);
  await page.goto('/');
}

export async function runCommand(page: Page, query: string, title: RegExp): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option', { name: title }).click();
}

export async function openSettings(page: Page): Promise<void> {
  await runCommand(page, 'Open User Settings JSON', /Open User Settings \(JSON\)/);
  await expect(settingsTab(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
}

/** Replaces the settings text as a paste, so Monaco does not close brackets or quotes by itself. */
export async function replaceText(page: Page, text: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+a');
  await activeEditor(page).evaluate((editor, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await expect.poll(async () => (await renderedText(settingsEditor(page))).trimEnd()).toBe(text.trimEnd());
}

export async function saveSettings(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+s');
  await expect(settingsTab(page)).not.toHaveAccessibleDescription('Modified');
}

export const persistedSettings = (page: Page) => page.evaluate(key => localStorage.getItem(key), settingsKey);
