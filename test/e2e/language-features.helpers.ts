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

/**
 * Runs one of the fixture's report commands, dismisses its message and gives the message's line that
 * starts with `prefix`. With `refocus`, the active editor has the focus again afterwards.
 */
export async function reportFixture(page: Page, command: string, prefix: string, refocus = true): Promise<string> {
  await runCommand(page, command);
  const toast = message(page, new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).last();
  await expect(toast).toBeVisible({ timeout: 10_000 });
  const text = (await toast.innerText()).split('\n').find(line => line.startsWith(prefix))!;
  await page.getByRole('region', { name: text }).getByRole('button', { name: 'Dismiss message' }).click();
  if (refocus) {
    await activeEditor(page).focus();
  }
  return text;
}

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
  return reportFixture(page, 'Language Features: Report Completions', 'Resolved: ');
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

// --- Formatting, code actions and rename ---------------------------------------------------------

/** Runs the fixture's report of its edit providers and gives its message. */
export async function reportEdits(page: Page): Promise<string> {
  return reportFixture(page, 'Language Features: Report Edits', 'Edits: ');
}

/** Monaco's code action menu (quick fixes, refactorings, source actions). */
export const actionMenu = (page: Page): Locator => page.getByRole('listbox', { name: 'Action Widget' });

/** The labels of the code action menu's entries, in display order. */
export const actionNames = (page: Page): Promise<string[]> =>
  actionMenu(page).getByRole('option').evaluateAll(options => options.map(option => option.getAttribute('aria-label') ?? ''));

/**
 * Opens the code action menu with `key` (Ctrl+. for quick fixes) until it shows: the fixture's
 * diagnostics and providers arrive a moment after the language does.
 */
export async function openActionMenu(page: Page, key = 'ControlOrMeta+.'): Promise<void> {
  await expect.poll(async () => {
    if (!await actionMenu(page).isVisible()) {
      await page.keyboard.press(key);
    }
    return actionMenu(page).isVisible({ timeout: 1000 }).catch(() => false);
  }, { timeout: 20_000, intervals: [500, 1000] }).toBe(true);
}

/** Monaco's rename input of the active editor. */
export const renameInput = (page: Page): Locator => activeGroup(page).getByRole('textbox', { name: /^Rename input/ });

/** An inline message of the active editor (Monaco's, where a provider's refusal shows). */
export const editorMessage = (page: Page, text: string): Locator => activeGroup(page).locator('.monaco-editor-overlaymessage').filter({ hasText: text });

// --- Navigation: symbols, links, definitions, folding, code lenses -------------------------------

/** Runs the fixture's report of `vscode.executeDocumentSymbolProvider` for the active editor and gives its message. */
export async function reportSymbols(page: Page): Promise<string> {
  return reportFixture(page, 'Language Features: Report Symbols', 'Symbols: ');
}

/** The entries of Monaco's quick outline (Ctrl+Shift+O), asked until it lists something. */
export async function openQuickOutline(page: Page): Promise<Locator> {
  const options = page.locator('.quick-input-widget').filter({ visible: true }).getByRole('option');
  await expect.poll(async () => {
    if (!await options.count()) {
      await page.keyboard.press('Escape');
      await activeEditor(page).focus();
      await page.keyboard.press('Control+Shift+O');
    }
    return options.count();
  }, { timeout: 20_000, intervals: [1000] }).toBeGreaterThan(0);
  return options;
}

/** A link Monaco underlines in the active editor, by its text. */
export const editorLink = (page: Page, text: string): Locator =>
  activeGroup(page).locator('.view-line .detected-link').filter({ hasText: text });

/** Follows a link as the user does: Ctrl (Cmd) and click. */
export async function followLink(page: Page, text: string): Promise<void> {
  const link = editorLink(page, text);
  await expect(link).toBeVisible({ timeout: 20_000 });
  // Monaco replaces the underline's DOM node when Ctrl and the pointer activate it.
  await page.mouse.move(0, 0);
  await page.keyboard.down('ControlOrMeta');
  try {
    await link.hover();
    const activeLink = activeGroup(page).locator('.view-line .detected-link-active').filter({ hasText: text });
    await activeLink.click();
  } finally {
    await page.keyboard.up('ControlOrMeta');
  }
}

/** The code lenses Monaco shows in the active editor, by their titles. */
export const codeLens = (page: Page, title: string | RegExp): Locator =>
  activeGroup(page).locator('.codelens-decoration a').filter({ hasText: title });
