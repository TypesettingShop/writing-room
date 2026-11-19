import { readFileSync } from 'node:fs';
import type { Locator, Page, Request } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect, renderedText } from './fixtures.js';

/** A fixture folder under `test/fixtures/extensions/language-basics/`: `''` is the main fixture. */
export type LanguageFixture = '' | 'broken/';

function manifest(fixture: LanguageFixture): IExtensionManifest {
  return JSON.parse(readFileSync(new URL(`../fixtures/extensions/language-basics/${fixture}package.json`, import.meta.url), 'utf8')) as IExtensionManifest;
}

export function languageFixtureLocation(fixture: LanguageFixture = ''): string {
  return extensionFixtureLocation('language-basics') + fixture;
}

/** Installs the language fixtures before the workbench starts, then opens the app. */
export async function openWithLanguageFixtures(page: Page, fixtures: readonly LanguageFixture[] = ['']): Promise<void> {
  await seedInstalledExtensions(page, fixtures.map(fixture => ({ location: languageFixtureLocation(fixture), manifest: manifest(fixture) })));
  await page.goto('/');
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

export const activeGroup = (page: Page): Locator => page.locator('[data-group-id].active');
export const activeEditor = (page: Page): Locator => activeGroup(page).getByRole('textbox', { name: 'Editor content' });
export const languageStatus = (page: Page): Locator => page.getByRole('button', { name: 'Select Language Mode', exact: true });

/** Opens a new untitled text editor from the File menu and waits for its text to have focus. */
export async function newUntitled(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File', exact: true }).click();
  await expect(activeEditor(page)).toBeFocused({ timeout: 20_000 });
}

/** Runs a command from the palette by its full title. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox');
  await palette.fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

/** Picks the active editor's language from the status bar, by the language's name. */
export async function changeLanguage(page: Page, languageName: string): Promise<void> {
  await languageStatus(page).click();
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill(languageName);
  await page.getByRole('option', { name: new RegExp('^' + languageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b') }).first().click();
  await expect(languageStatus(page)).toHaveText(languageName);
  await activeEditor(page).focus();
}

/** Types into the active editor as a paste, so Monaco neither closes brackets nor indents. */
export async function pasteText(page: Page, text: string): Promise<void> {
  await activeEditor(page).evaluate((editor, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

/** Monaco's block comment key: Shift+Alt+A, and Ctrl+Shift+A on Linux. */
export const blockCommentKey = process.platform === 'linux' ? 'Control+Shift+a' : 'Shift+Alt+a';

/** Opens the context menu of the active editor's text. */
export async function openEditorContextMenu(page: Page): Promise<void> {
  await activeGroup(page).locator('.monaco-editor .view-lines').first().click({ button: 'right' });
}

export const editorText = async (page: Page): Promise<string> => (await renderedText(activeGroup(page))).trimEnd();

/** An information message's toast, by its text. */
export const message = (page: Page, text: string | RegExp): Locator => page.getByRole('status').filter({ hasText: text });

/** Asks the fixture for the TextMate scopes of `line` in `languageId`: one entry per token. */
export async function tokenScopes(page: Page, languageId: string, line: string): Promise<{ text: string; scopes: string[] }[] | null> {
  await runCommand(page, 'Language Basics: Report Token Scopes');
  const languageInput = page.getByRole('textbox', { name: 'Language id' });
  await languageInput.fill(languageId);
  await languageInput.press('Enter');
  const lineInput = page.getByRole('textbox', { name: 'Line' });
  await lineInput.fill(line);
  await lineInput.press('Enter');
  const toast = message(page, /^Scopes: /).last();
  await expect(toast).toBeVisible({ timeout: 20_000 });
  const text = (await toast.innerText()).split('\n').find(part => part.startsWith('Scopes: '))!;
  // Close it, so the next report is the only one.
  await page.getByRole('region', { name: text }).getByRole('button', { name: 'Dismiss message' }).click();
  return JSON.parse(text.slice('Scopes: '.length)) as { text: string; scopes: string[] }[] | null;
}
