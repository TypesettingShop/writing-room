import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect } from './fixtures.js';

const manifest = (path: string) => JSON.parse(readFileSync(
  new URL('../fixtures/extensions/diagnostics/' + path + 'package.json', import.meta.url), 'utf8')) as IExtensionManifest;

export const settingsKey = 'writing-room:storage:0:user.settings.json';
/** Five comment lines the fixture's diagnostics point at, one per line. */
export const settingsText = '// first line\n// second line\n// third line\n// fourth line\n// fifth line\n{}\n';

export const settingsTab = (page: Page) => page.getByRole('tab', { name: 'settings.json', exact: true });
export const settingsEditor = (page: Page) => page.locator('[data-group-id]').filter({ has: settingsTab(page) }).first();
export const activeEditor = (page: Page) => page.locator('[data-group-id].active').getByRole('textbox', { name: 'Editor content' });

/** Installs both diagnostics fixtures and the settings text before the workbench starts, then opens the app. */
export async function openWithDiagnosticsFixtures(page: Page, settings = settingsText): Promise<void> {
  await seedInstalledExtensions(page, [
    { location: extensionFixtureLocation('diagnostics'), manifest: manifest('') },
    { location: extensionFixtureLocation('diagnostics') + 'other/', manifest: manifest('other/') },
  ]);
  await page.addInitScript(({ key, value }) => {
    const seeded = 'writing-room:test:diagnostics-settings';
    if (window.top === window && !sessionStorage.getItem(seeded)) {
      localStorage.setItem(key, value);
      sessionStorage.setItem(seeded, 'true');
    }
  }, { key: settingsKey, value: settings });
  await page.goto('/');
}

export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

export async function openSettings(page: Page): Promise<void> {
  await runCommand(page, 'Preferences: Open User Settings (JSON)');
  await expect(settingsTab(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
}

/** Rests the mouse on the text of a rendered line; Monaco renders its spaces as non-breaking ones. */
export async function hoverLine(page: Page, text: string): Promise<void> {
  await page.mouse.move(0, 0);
  const line = settingsEditor(page).locator('.view-line').filter({ hasText: new RegExp(text.replaceAll(' ', '\\s')) });
  // Near the start of the line: every fixture range starts at its first column.
  await line.hover({ position: { x: 8, y: 5 } });
}
