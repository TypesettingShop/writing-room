import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { reportFixture } from './language-features.helpers.js';

export const SYMBOLS_PLACEHOLDER = 'Type the name of a symbol to open.';
export const NO_RESULTS = 'No matching workspace symbols';

/** The one quick input field, whatever it is named now. */
export const quickInputField = (page: Page): Locator => page.getByRole('combobox');

/** The Go to Symbol in Workspace field. */
export const symbolsField = (page: Page): Locator => page.getByRole('combobox', { name: SYMBOLS_PLACEHOLDER });

/** Opens a new untitled text editor from the File menu and waits until its text has focus. */
export async function openUntitledEditor(page: Page): Promise<Locator> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
  const editor = page.locator('[data-group-id]').first().getByRole('textbox', { name: 'Editor content' });
  await expect(editor).toBeFocused({ timeout: 20_000 });
  return editor;
}

/** Opens Go to Symbol in Workspace from the command palette. */
export async function openFromPalette(page: Page): Promise<void> {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox', { name: 'Type a command' });
  await palette.fill('Go to Symbol in Workspace');
  await expect(page.getByRole('option', { name: 'Go to Symbol in Workspace...', exact: true })).toHaveAttribute('aria-selected', 'true');
  await palette.press('Enter');
}

/** The symbols screen is open with `#` and the caret after it. */
export async function expectSymbolsOpen(page: Page): Promise<void> {
  const field = symbolsField(page);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('#');
  expect(await field.evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd]))
    .toEqual([1, 1]);
}

/** A row of the symbols screen, by the symbol's name. */
export const symbolRow = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('option', { name: typeof name === 'string' ? new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:,|\\s|$)') : name });

/** Runs the language feature fixture's workspace symbol report and gives its message. */
export async function reportWorkspaceSymbols(page: Page): Promise<string> {
  return reportFixture(page, 'Language Features: Report Workspace Symbols', 'Workspace symbols: ', false);
}
