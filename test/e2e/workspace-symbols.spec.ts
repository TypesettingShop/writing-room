import { expect, test } from './fixtures.js';
import {
  expectSymbolsOpen, NO_RESULTS, openFromPalette, openUntitledEditor, quickInputField, symbolsField,
} from './workspace-symbols.helpers.js';

test('the palette lists Go to Symbol in Workspace with its key, and it opens with # and no provider says so', async ({ appPage: page }) => {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox', { name: 'Type a command' });
  await expect(palette).toBeFocused();
  await palette.fill('symbol in work');
  const entry = page.getByRole('option', { name: 'Go to Symbol in Workspace...', exact: true });
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAccessibleDescription(/^(Ctrl|Control|⌘|Cmd)\+T$/);
  await palette.press('Escape');

  await openFromPalette(page);
  await expectSymbolsOpen(page);
  const noResults = page.getByRole('option', { name: NO_RESULTS });
  await expect(noResults).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  // The row chooses nothing: the screen stays.
  await symbolsField(page).press('Enter');
  await expect(symbolsField(page)).toBeFocused();
  await noResults.click();
  await expect(symbolsField(page)).toBeFocused();
  await expect(symbolsField(page)).toHaveValue('#');
  await symbolsField(page).pressSequentially('anything');
  await expect(noResults).toBeVisible();
});

test('Ctrl+T opens the screen from an editor, Escape gives the editor its focus back', async ({ appPage: page }) => {
  const editor = await openUntitledEditor(page);
  await page.keyboard.type('draft');
  await page.keyboard.press('ControlOrMeta+T');
  await expectSymbolsOpen(page);
  await symbolsField(page).press('Escape');
  await expect(quickInputField(page)).toHaveCount(0);
  await expect(editor).toBeFocused();
  // The key did not reach the editor as text.
  await page.keyboard.type('!');
  await expect(page.locator('[data-group-id]').first().locator('.view-lines')).toHaveText('draft!');

  await openFromPalette(page);
  await expectSymbolsOpen(page);
  await symbolsField(page).press('Escape');
  await expect(editor).toBeFocused();
});

test('deleting # shows the help row, and choosing it puts # back', async ({ appPage: page }) => {
  await page.keyboard.press('ControlOrMeta+T');
  await expectSymbolsOpen(page);
  await symbolsField(page).press('Backspace');
  const field = quickInputField(page);
  await expect(field).toHaveValue('');
  const help = page.getByRole('option', { name: '# Go to Symbol in Workspace' });
  await expect(help).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(1);
  await field.press('Enter');
  await expectSymbolsOpen(page);
  await expect(page.getByRole('option', { name: NO_RESULTS })).toBeVisible();

  await symbolsField(page).press('Backspace');
  await help.click();
  await expectSymbolsOpen(page);
});

test('one quick input at a time: Ctrl+T replaces the palette, and the palette still filters as before', async ({ appPage: page }) => {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox', { name: 'Type a command' });
  await expect(palette).toBeFocused();
  await page.keyboard.press('ControlOrMeta+T');
  await expectSymbolsOpen(page);
  await expect(page.getByRole('combobox')).toHaveCount(1);

  await page.keyboard.press('F1');
  await expect(palette).toBeFocused();
  await expect(palette).toHaveValue('');
  await expect(page.getByRole('combobox')).toHaveCount(1);
  // A command title holds `#`-free text; the palette filters on its whole value.
  await palette.fill('go to symbol');
  await expect(page.getByRole('option', { name: 'Go to Symbol in Workspace...', exact: true })).toBeVisible();
  await palette.fill('#');
  await expect(page.getByRole('option', { name: 'Go to Symbol in Workspace...', exact: true })).toHaveCount(0);
  await palette.press('Escape');
  await expect(page.getByRole('combobox')).toHaveCount(0);
});
