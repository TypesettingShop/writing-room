import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect } from './fixtures.js';
import { activeEditor, activeGroup, changeLanguage, message, newUntitled, runCommand } from './language-basics.helpers.js';

export { activeEditor, activeGroup, editorText, message, pasteText, runCommand } from './language-basics.helpers.js';

/*
 * The language feature fixture (`test/fixtures/extensions/language-features/`) registers providers for
 * its own language, `lftest` ("LF Test"). Each group of features adds its providers there and its
 * helpers here.
 */

const manifest = JSON.parse(readFileSync(
  new URL('../fixtures/extensions/language-features/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

export const languageName = 'LF Test';

/** Installs the fixture before the workbench starts, then opens the app. */
export async function openWithLanguageFeatures(page: Page): Promise<void> {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('language-features'), manifest }]);
  await page.goto('/');
}

/** Opens an untitled editor in the fixture's language and waits for the fixture to have registered its providers. */
export async function openFixtureEditor(page: Page): Promise<void> {
  await newUntitled(page);
  await changeLanguage(page, languageName);
  await expect(message(page, 'Language features fixture activated')).toBeVisible({ timeout: 20_000 });
  await activeEditor(page).focus();
}

// --- Completions ---------------------------------------------------------------------------------

/** Monaco's suggest list of the active editor. */
export const suggestList = (page: Page): Locator => activeGroup(page).getByRole('listbox', { name: 'Suggest' });

/** The accessible names of the suggestions, in display order: `label, Kind`. */
export const suggestionNames = (page: Page): Promise<string[]> =>
  suggestList(page).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label') ?? ''));

export const suggestion = (page: Page, label: string): Locator =>
  suggestList(page).getByRole('option').filter({ hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

/** Asks for suggestions until the list shows: the providers arrive a moment after the language does. */
export async function triggerSuggest(page: Page): Promise<void> {
  await expect.poll(async () => {
    if (!await suggestList(page).isVisible()) {
      await page.keyboard.press('Control+Space');
    }
    return suggestList(page).isVisible({ timeout: 1000 }).catch(() => false);
  }, { timeout: 20_000, intervals: [500, 1000] }).toBe(true);
}

/** The details pane of the focused suggestion, which Ctrl+Space shows; asked until it shows `text`. */
export async function expectSuggestDetails(page: Page, text: string): Promise<void> {
  const details = activeGroup(page).locator('.suggest-details-container');
  await expect.poll(async () => {
    if (!await details.isVisible()) {
      await page.keyboard.press('Control+Space');
    }
    return details.first().innerText({ timeout: 1000 }).catch(() => '');
  }, { timeout: 20_000, intervals: [1000] }).toContain(text);
}

/** Runs the fixture's report and gives its message: resolve counts, the host's completion cache, hover command runs. */
export async function reportCompletions(page: Page): Promise<string> {
  await runCommand(page, 'Language Features: Report Completions');
  const toast = message(page, /^Resolved: /).last();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  const text = (await toast.innerText()).split('\n').find(line => line.startsWith('Resolved: '))!;
  await page.getByRole('region', { name: text }).getByRole('button', { name: 'Dismiss message' }).click();
  await activeEditor(page).focus();
  return text;
}

// --- Hover and signature help --------------------------------------------------------------------

/** Rests the mouse on `word` in the active editor's rendered text. */
export async function hoverWord(page: Page, word: string): Promise<void> {
  await page.mouse.move(0, 0);
  const token = activeGroup(page).locator('.view-line span span').filter({ hasText: word }).first();
  await token.hover({ position: { x: 4, y: 5 } });
}

/** Monaco's hover of the active editor; nothing else names it. */
export const hoverWidget = (page: Page): Locator => activeGroup(page).locator('.monaco-hover').filter({ visible: true });

/** Monaco's parameter hints of the active editor, and the parameter it marks as active. */
export const parameterHints = (page: Page): Locator => activeGroup(page).locator('.parameter-hints-widget');
export const activeParameter = (page: Page): Locator => parameterHints(page).locator('.signature .parameter.active');
