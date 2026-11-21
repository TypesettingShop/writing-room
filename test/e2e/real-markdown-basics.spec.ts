// Acceptance of the master epic (wr-jbmd.eke): two real Open VSX packages with no code, `vscode.markdown` 1.95.3 and
// `GitHub.github-vscode-theme` 6.3.5, installed unchanged from the Extensions view out of the fixture gallery
// (test/fixtures/routes/openvsx.mjs serves the pinned, signed cache), then used, kept over a reload and removed.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startWithMarkdownSource } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { activeGroup, editorText, languageStatus, pasteText, toggleBlockCommentUntil } from './language-basics.helpers.js';
import { packageFolders, savedRecords } from './packages.helpers.js';
import {
  installedExtensions, installFromGallery, openExtensions, realPin, requireRealExtensions, routeFixtureGallery, uninstallButton,
} from './real-extensions.helpers.js';
import { chooseTheme, colorVariable, editorBackground, openThemePicker, persistedSettings, rgb } from './themes.helpers.js';

test.beforeEach(async ({ page }) => {
  await startWithMarkdownSource(page);
});

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The messages logged under the two extensions' own ids (`[vscode.markdown] …`, `[github.github-vscode-theme] …`),
 * exactly; what the workbench logs under the language id (`[markdown] …`) is not collected here, and the editor checks
 * below catch its failures instead. Neither extension has an unsupported contribution, and the
 * `[markdown]` defaults of keys no extension registers are ignored without a word. The one warning: four of the theme's
 * files give `symbolIcon.constantForeground` an array of colors, which the theme service drops with this documented
 * warning (docs/extension-api-theming-and-views.md, `colors`); only GitHub Dark Default of them is loaded here.
 */
const allowedMessages = [
  "warning: [github.github-vscode-theme] ./themes/dark-default.json: the value of 'symbolIcon.constantForeground' is not a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA); it is ignored.",
];

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const suggestions = (page: Page) => activeGroup(page).locator('.suggest-widget');
const boldSnippet = (page: Page) => suggestions(page).getByRole('option').filter({ hasText: 'Insert bold text' });
const markdownName = /^Uninstall Markdown Language Basics/;
const themeName = /^Uninstall GitHub Theme/;

/** The computed color and weight of the first rendered token of the active editor whose text contains `text`. */
async function tokenStyle(page: Page, text: string): Promise<{ color: string; fontWeight: string }> {
  const token = activeGroup(page).locator('.monaco-editor .view-line span span').filter({ hasText: text }).first();
  await expect(token).toBeVisible();
  return token.evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.color, fontWeight: style.fontWeight };
  });
}

const color = async (page: Page, text: string) => (await tokenStyle(page, text)).color;

async function show(page: Page, name: string): Promise<void> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}

async function clear(page: Page): Promise<void> {
  const text = activeGroup(page).getByRole('textbox', { name: 'Editor content' });
  await activeGroup(page).locator('.monaco-editor .view-lines').first().click();
  await expect(text).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect.poll(() => editorText(page)).toBe('');
}

/**
 * Selects a word and types `*` over it. The extension's language configuration surrounds with `*`; Monaco's built-in
 * markdown, which `.md` files have before the extension, surrounds only with brackets and backticks and replaces it.
 */
async function expectStarOverWord(page: Page, expected: string): Promise<void> {
  await clear(page);
  await pasteText(page, 'word');
  await expect.poll(() => editorText(page)).toBe('word');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.type('*');
  await expect.poll(() => editorText(page)).toBe(expected);
}

/** Types `bold`, opens the suggestions and expects `rows` rows of the extension's `bold` snippet among them. */
async function expectBoldSnippetRows(page: Page, rows: number): Promise<void> {
  await clear(page);
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+Space');
  await expect(suggestions(page)).toBeVisible({ timeout: 15_000 });
  // The snippet rows come from their own provider, after the word rows.
  await page.waitForTimeout(500);
  // While the widget still says Loading..., no count is final: a count of zero would pass before the providers answer.
  await expect(suggestions(page).locator('.message').filter({ hasText: 'Loading...' })).toBeHidden({ timeout: 15_000 });
  await expect(boldSnippet(page)).toHaveCount(rows);
}

test('installs vscode.markdown and the GitHub theme from the gallery, uses them, keeps them over a reload and removes them', async ({ page }) => {
  requireRealExtensions();
  test.setTimeout(180_000);
  const markdownPin = await realPin('vscode.markdown');
  const themePin = await realPin('GitHub.github-vscode-theme');
  const messages: string[] = [];
  page.on('console', message => {
    if (/^\[(vscode\.markdown|github\.github-vscode-theme)\]/i.test(message.text())) {
      messages.push(message.type() + ': ' + message.text());
    }
  });
  const wasm: number[] = [];
  page.on('response', response => {
    if (/\/onig[^/]*\.wasm(\?|$)/.test(response.url())) {
      wasm.push(response.status());
    }
  });
  await routeFixtureGallery(page);

  // v0.1.0's default theme: the TextMate grammar draws text in editor.foreground, Monaco's built-in tokenizer in vs-dark's.
  const textMateText = rgb('#d7dfec');
  const builtinText = rgb('#d4d4d4');
  const builtinHeading = rgb('#569cd6');

  await test.step('Before installing: README.md is Monaco\'s built-in markdown, .markdn is plain text', async () => {
    await page.goto('/');
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'README.md', '# Title\n\nPlain body\n\n**Strong**\n');
    await writeWorkspaceFile(page, 'notes.markdn', 'notes\n');
    await writeWorkspaceFile(page, 'edit.md', '');
    for (const name of ['notes.markdn', 'edit.md', 'README.md']) {
      await treeItem(page, name).dblclick();
      await expect(tab(page, name)).toBeVisible();
    }
    await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('Strong');
    await expect(languageStatus(page)).toHaveText('Markdown');
    // The built-in tokenizer loads on demand; until then the line is one plain token.
    await expect.poll(() => tokenStyle(page, 'Title'), { timeout: 20_000 }).toEqual({ color: builtinHeading, fontWeight: '400' });
    expect(await color(page, 'Plain body')).toBe(builtinText);
    await show(page, 'notes.markdn');
    await expect(languageStatus(page)).toHaveText('Plain Text');
    await show(page, 'edit.md');
    await expectStarOverWord(page, '*');
    await expectBoldSnippetRows(page, 0);
    await page.keyboard.press('Escape');
  });

  await test.step('Install vscode.markdown from the Extensions view: the pinned, signed package', async () => {
    const confirmation = await installFromGallery(page, 'vscode.markdown', 'Markdown Language Basics', markdownName);
    expect(confirmation).toContain('vscode · 1.95.3 · vscode.markdown');
    // `^Install ` also matches "Install Contributions Only"; a package with no code is a web extension.
    expect(confirmation).toContain('Web extension');
    expect(confirmation).toContain('Source: open-vsx.org');
    expect(confirmation).toContain('SHA-256: ' + markdownPin.vsix.sha256);
    expect(confirmation).toContain(`Signature: verified (${markdownPin.publicKey})`);
    await expect(installedExtensions(page).getByRole('listitem').filter({ hasText: 'vscode.markdown · 1.95.3 · Open VSX' })).toBeVisible();
    expect(await savedRecords(page)).toEqual([expect.objectContaining({
      identifier: 'vscode.markdown', version: '1.95.3', source: 'gallery', signature: 'verified', packageSha256: markdownPin.vsix.sha256,
    })]);
    expect((await packageFolders(page)).some(path => path.startsWith('/extensions/vscode.markdown-1.95.3/'))).toBe(true);
  });

  await test.step('Use the language: mode, grammar, configuration and the bold snippet', async () => {
    await show(page, 'notes.markdn');
    await expect(languageStatus(page)).toHaveText('Markdown');
    await show(page, 'README.md');
    await expect(languageStatus(page)).toHaveText('Markdown');
    await expect.poll(() => color(page, 'Plain body'), { timeout: 20_000 }).toBe(textMateText);
    expect(await color(page, 'Title')).not.toBe(textMateText);
    expect((await tokenStyle(page, 'Strong')).fontWeight).toBe('700');
    // An extension the language now has: a file opened from here on is markdown.
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await writeWorkspaceFile(page, 'later.markdn', 'later\n');
    await treeItem(page, 'later.markdn').dblclick();
    await expect(tab(page, 'later.markdn')).toHaveAttribute('aria-selected', 'true');
    await expect(languageStatus(page)).toHaveText('Markdown');

    await show(page, 'edit.md');
    await expectStarOverWord(page, '*word*');
    await clear(page);
    await page.keyboard.type('(');
    await expect.poll(() => editorText(page)).toBe('()');
    await clear(page);
    await pasteText(page, 'note');
    await toggleBlockCommentUntil(page, '<!-- note -->');
    await expectBoldSnippetRows(page, 1);
    await boldSnippet(page).click();
    await expect.poll(() => editorText(page)).toBe('****');
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await page.keyboard.type('y');
    await expect.poll(() => editorText(page)).toBe('**x**y');
    // Saved empty, so the reload below has no draft to restore.
    await clear(page);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(tab(page, 'edit.md')).not.toHaveClass(/dirty/);
  });

  await test.step('Install the GitHub theme and choose GitHub Dark Default, then GitHub Light Default', async () => {
    const confirmation = await installFromGallery(page, 'github-vscode-theme', 'GitHub Theme', themeName);
    expect(confirmation).toMatch(/GitHub · 6\.3\.5 · github\.github-vscode-theme/i);
    expect(confirmation).toContain('Web extension');
    expect(confirmation).toContain('SHA-256: ' + themePin.vsix.sha256);
    expect(confirmation).toContain(`Signature: verified (${themePin.publicKey})`);
    await show(page, 'README.md');

    // The picker closes before the theme file is read when its preview has not finished: the colors arrive a moment later.
    await chooseTheme(page, 'GitHub Dark Default');
    await expect.poll(() => colorVariable(page, 'editor.background')).toBe('#0d1117');
    await expect.poll(() => editorBackground(page)).toBe(rgb('#0d1117'));
    // markup.heading of the theme: Monaco's built-in tokenizer would give the heading the theme's keyword color.
    await expect.poll(() => tokenStyle(page, 'Title')).toEqual({ color: rgb('#79c0ff'), fontWeight: '700' });
    await expect.poll(() => color(page, 'Plain body')).toBe(rgb('#e6edf3'));

    await chooseTheme(page, 'GitHub Light Default');
    await expect.poll(() => colorVariable(page, 'editor.background')).toBe('#ffffff');
    await expect.poll(() => editorBackground(page)).toBe(rgb('#ffffff'));
    await expect.poll(() => color(page, 'Title')).toBe(rgb('#0550ae'));
    await expect.poll(() => color(page, 'Plain body')).toBe(rgb('#1f2328'));
    expect(JSON.parse((await persistedSettings(page))!)).toEqual({ 'workbench.colorTheme': 'GitHub Light Default' });
  });

  await test.step('Reload: the theme, the language and the grammar are still there', async () => {
    await page.reload();
    await expect(tab(page, 'README.md')).toBeVisible({ timeout: 20_000 });
    await show(page, 'README.md');
    // Until the theme's extension is registered again and its file read, the default dark theme shows.
    await expect.poll(() => colorVariable(page, 'editor.background'), { timeout: 20_000 }).toBe('#ffffff');
    await expect(languageStatus(page)).toHaveText('Markdown');
    await expect.poll(() => tokenStyle(page, 'Title'), { timeout: 20_000 }).toEqual({ color: rgb('#0550ae'), fontWeight: '700' });
    expect(await editorBackground(page)).toBe(rgb('#ffffff'));
    await show(page, 'later.markdn');
    await expect(languageStatus(page)).toHaveText('Markdown');
    await show(page, 'edit.md');
    await expectBoldSnippetRows(page, 1);
    await page.keyboard.press('Escape');
    await clear(page);
  });

  await test.step('Remove both: nothing of them stays but the saved theme setting', async () => {
    await openExtensions(page);
    await uninstallButton(page, markdownName).click();
    await uninstallButton(page, themeName).click();
    await expect(uninstallButton(page, /^Uninstall (Markdown Language Basics|GitHub Theme)/)).toHaveCount(0);
    await expect.poll(() => savedRecords(page)).toEqual([]);
    await expect.poll(() => packageFolders(page)).toEqual([]);

    await expect.poll(() => colorVariable(page, 'editor.background')).toBe('#171b24');
    expect(await persistedSettings(page)).toContain('"workbench.colorTheme": "GitHub Light Default"');
    await show(page, 'README.md');
    expect(await editorBackground(page)).toBe(rgb('#1e1e1e'));
    await expect(languageStatus(page)).toHaveText('Markdown');
    await expect.poll(() => color(page, 'Plain body'), { timeout: 20_000 }).toBe(builtinText);
    await expect.poll(() => tokenStyle(page, 'Title')).toEqual({ color: builtinHeading, fontWeight: '400' });
    await show(page, 'later.markdn');
    await expect(languageStatus(page)).toHaveText('Plain Text');
    await show(page, 'notes.markdn');
    await expect(languageStatus(page)).toHaveText('Plain Text');
    await show(page, 'edit.md');
    await expectStarOverWord(page, '*');
    await expectBoldSnippetRows(page, 0);
    await page.keyboard.press('Escape');
    await clear(page);

    const picker = await openThemePicker(page);
    // The list is drawn first, so that the zero below is not read off a picker with no rows yet.
    await expect(page.getByRole('option').first()).toBeVisible();
    await picker.fill('GitHub');
    await expect(page.getByRole('option', { name: /^GitHub/ })).toHaveCount(0);
    await picker.press('Escape');
  });

  expect(messages).toEqual(allowedMessages);
  expect(wasm.length).toBeGreaterThan(0);
  expect(wasm.every(status => status === 200)).toBe(true);
});
