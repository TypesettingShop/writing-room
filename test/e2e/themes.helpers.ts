import { readFileSync } from 'node:fs';
import type { Locator, Page, Request } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { settingsKey } from './configuration.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect } from './fixtures.js';

/** A fixture folder under `test/fixtures/extensions/theming/`. */
export type ThemingFixture = 'color-theme/' | 'theme-api/';

export { persistedSettings, settingsKey } from './configuration.helpers.js';

function manifest(fixture: ThemingFixture): IExtensionManifest {
  return JSON.parse(readFileSync(new URL(`../fixtures/extensions/theming/${fixture}package.json`, import.meta.url), 'utf8')) as IExtensionManifest;
}

export function themingFixtureLocation(fixture: ThemingFixture): string {
  return extensionFixtureLocation('theming') + fixture;
}

/** Installs theming fixtures, and settings.json when `settings` is given, before the workbench starts; then opens the app. */
export async function openWithThemingFixtures(page: Page, fixtures: readonly ThemingFixture[], settings?: string): Promise<void> {
  if (settings !== undefined) {
    await page.addInitScript(({ key, text }) => {
      if (!sessionStorage.getItem('writing-room:test:theme-settings-seeded')) {
        localStorage.setItem('writing-room:storage:version', '2');
        localStorage.setItem(key, text);
        sessionStorage.setItem('writing-room:test:theme-settings-seeded', 'true');
      }
    }, { key: settingsKey, text: settings });
  }
  await seedInstalledExtensions(page, fixtures.map(fixture => ({ location: themingFixtureLocation(fixture), manifest: manifest(fixture) })));
  await page.goto('/');
}

/** The workbench container, which carries the color variables and the kind class. */
export const workbench = (page: Page): Locator => page.locator('.monaco-workbench');

/** The value of a color's CSS variable on the workbench. */
export function colorVariable(page: Page, id: string): Promise<string> {
  return workbench(page).evaluate((element, name) => getComputedStyle(element).getPropertyValue(name).trim(),
    '--vscode-' + id.replace(/\./g, '-'));
}

/** The kind class on the workbench: `vs`, `vs-dark`, `hc-black` or `hc-light`. */
export function kindClass(page: Page): Promise<string | undefined> {
  return workbench(page).evaluate(element => ['vs', 'vs-dark', 'hc-black', 'hc-light'].find(name => element.classList.contains(name)));
}

/** Opens the color theme picker from the command palette. */
export async function openThemePicker(page: Page): Promise<Locator> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Preferences: Color Theme');
  await page.getByRole('option', { name: 'Preferences: Color Theme', exact: true }).click();
  const input = page.getByRole('combobox', { name: /Select Color Theme/ });
  await expect(input).toBeFocused();
  return input;
}

/** Chooses a theme by its label in the picker. */
export async function chooseTheme(page: Page, label: string): Promise<void> {
  const input = await openThemePicker(page);
  await input.fill(label);
  await expect(page.getByRole('option', { name: new RegExp('^' + label) }).first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

/** Opens a new untitled text editor from the File menu and waits for its text to have focus. */
export async function newUntitled(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File', exact: true }).click();
  await expect(page.locator('[data-group-id].active').getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
}

/** The background color Monaco paints in the active editor. */
export function editorBackground(page: Page): Promise<string> {
  return page.locator('[data-group-id].active .monaco-editor .monaco-editor-background').first()
    .evaluate(element => getComputedStyle(element).backgroundColor);
}

/** Every request whose URL matches `pattern`, from now on. */
export function recordRequests(page: Page, pattern: RegExp): string[] {
  const urls: string[] = [];
  page.on('request', (request: Request) => {
    if (pattern.test(request.url())) {
      urls.push(request.url());
    }
  });
  return urls;
}

/** `#rrggbb` as the `rgb(…)` a computed style gives. */
export function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
