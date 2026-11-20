import { selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { expect, test } from './fixtures.js';
import { editorText, openFixtureEditor, openWithLanguageFeatures, runCommand } from './language-features.helpers.js';
import {
  expectSymbolsOpen, NO_RESULTS, openFromPalette, openUntitledEditor, quickInputField, reportWorkspaceSymbols, symbolRow, symbolsField,
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

test.describe('with the language feature fixture\'s providers', () => {
  // Two workspace files, neither open: the fixture's heading provider reads them from the workspace folder.
  test.beforeEach(async ({ page }) => {
    await openWithLanguageFeatures(page);
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'alpha.lft', '# Alpha intro\ntext\n## Alpha usage\n');
    await writeWorkspaceFile(page, 'beta.lft', 'one\ntwo\n# Beta intro\nmore\n');
    await openFixtureEditor(page);
  });

  test('lists the headings of files that are not open with their paths, and opens the chosen one at its line with the focus in it', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+T');
    await expectSymbolsOpen(page);
    await symbolsField(page).pressSequentially('intro');
    await expect(symbolRow(page, '# Alpha intro')).toBeVisible({ timeout: 15_000 });
    await expect(symbolRow(page, '# Beta intro')).toBeVisible();
    await expect(symbolRow(page, '# Beta intro')).toContainText('Headings • beta.lft');
    // Only the names that hold the query.
    await expect(symbolRow(page, '## Alpha usage')).toHaveCount(0);
    await symbolRow(page, '# Beta intro').click();
    await expect(quickInputField(page)).toHaveCount(0);
    await expect(selectedTab(page.locator('[data-group-id].active'))).toHaveText(/beta\.lft/, { timeout: 15_000 });
    // The cursor stands at the start of the heading's line (line 3, not 2 or 4).
    await page.keyboard.type('X');
    await expect.poll(() => editorText(page)).toBe('one\ntwo\nX# Beta intro\nmore');
  });

  test('a late answer of an earlier query never joins the rows, and its token was cancelled', async ({ page }) => {
    await runCommand(page, 'Language Features: Slow Workspace Symbols');
    await page.keyboard.press('ControlOrMeta+T');
    await expectSymbolsOpen(page);
    await symbolsField(page).pressSequentially('stale');
    // Typed on before the slow answer came back.
    await page.waitForTimeout(400);
    await symbolsField(page).pressSequentially('r');
    await expect(symbolRow(page, 'query:staler')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);
    await expect(symbolRow(page, 'query:stale')).toHaveCount(0);
    await symbolsField(page).press('Escape');
    await expect.poll(() => reportWorkspaceSymbols(page), { timeout: 15_000 }).toMatch(/; cancelled [1-9]\d*;/);
  });

  test('a provider that throws does not keep the other provider\'s rows away', async ({ page }) => {
    await runCommand(page, 'Language Features: Throwing Workspace Symbols');
    await page.keyboard.press('ControlOrMeta+T');
    await expectSymbolsOpen(page);
    await symbolsField(page).pressSequentially('alpha');
    await expect(symbolRow(page, '# Alpha intro')).toBeVisible({ timeout: 15_000 });
    await expect(symbolRow(page, /^query:/)).toHaveCount(0);
  });

  test('closing the screen lets the extension host drop its answers, and the API command gives SymbolInformation', async ({ page }) => {
    await page.keyboard.press('ControlOrMeta+T');
    await expectSymbolsOpen(page);
    await expect(symbolRow(page, '# Alpha intro')).toBeVisible({ timeout: 15_000 });
    await symbolsField(page).press('Escape');
    await expect(quickInputField(page)).toHaveCount(0);
    // The report's own API command call keeps one answer per provider (as VS Code); the screen's are gone.
    const report = await reportWorkspaceSymbols(page);
    expect(report).toContain('# Alpha intro | # Beta intro | ## Alpha usage | query:');
    expect(report).toContain('; SymbolInformation true;');
    expect(Number(/; cached (\d+)$/.exec(report)?.[1])).toBeLessThanOrEqual(2);
  });

  test('a removed provider\'s rows are gone', async ({ page }) => {
    await runCommand(page, 'Language Features: Unregister Providers');
    await page.keyboard.press('ControlOrMeta+T');
    await expectSymbolsOpen(page);
    await expect(page.getByRole('option', { name: NO_RESULTS })).toBeVisible({ timeout: 15_000 });
    await expect(symbolRow(page, '# Alpha intro')).toHaveCount(0);
  });
});
