import type { Page } from '@playwright/test';
import { test as base } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  activeEditor, activeGroup, blockCommentKey, changeLanguage, editorText, languageStatus, message, newUntitled, openEditorContextMenu, openWithLanguageFixtures, pasteText,
  recordRequests, runCommand, tokenScopes,
} from './language-basics.helpers.js';

test.describe('language registry and language mode', () => {
  test('shows the language of the active text editor and changes it from the status bar', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await expect(languageStatus(page)).toHaveCount(0);
    await newUntitled(page);
    await expect(languageStatus(page)).toHaveText('Plain Text');

    await changeLanguage(page, 'Fixture Language');
    // The model, `editorLangId` and the status bar follow the choice: the menu shows the action whose
    // `when` is `editorLangId == fixturelang`.
    await openEditorContextMenu(page);
    await expect(page.getByRole('menuitem', { name: 'Fixture Language Action' })).toBeVisible();
    await page.keyboard.press('Escape');

    await changeLanguage(page, 'Markdown');
    await openEditorContextMenu(page);
    await expect(page.getByRole('menuitem', { name: /Cut|Copy/ }).first()).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fixture Language Action' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await runCommand(page, 'Change Language Mode');
    await page.getByRole('combobox').fill('Plain Text');
    await page.getByRole('option', { name: /^Plain Text/ }).click();
    await expect(languageStatus(page)).toHaveText('Plain Text');
  });

  test('activates the extension once its language is used, and not for plain text', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await page.keyboard.type('plain');
    await page.waitForTimeout(1000);
    await expect(message(page, 'Language basics fixture activated')).toHaveCount(0);

    await changeLanguage(page, 'Fixture Language');
    await expect(message(page, 'Language basics fixture activated')).toHaveCount(1);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');
    await page.waitForTimeout(500);
    await expect(message(page, 'Language basics fixture activated')).toHaveCount(1);
  });

  test('lists the contributed language ids through the API', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await runCommand(page, 'Language Basics: Report Language Ids');
    await expect(message(page, 'Language ids: fixturelang, markdown, plaintext')).toBeVisible({ timeout: 20_000 });
  });

  test('applies the configuration: auto closing pairs, comments, and a broken pattern drops only its field', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');

    await page.keyboard.type('(');
    await expect.poll(() => editorText(page)).toBe('()');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await pasteText(page, 'alpha beta');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press(blockCommentKey);
    await expect.poll(() => editorText(page)).toBe('/~ alpha beta ~/');
    await page.keyboard.press(blockCommentKey);
    await expect.poll(() => editorText(page)).toBe('alpha beta');
    await page.keyboard.press('ControlOrMeta+/');
    await expect.poll(() => editorText(page)).toBe('%% alpha beta');
  });

  test('a contributed configuration wins over the built-in one of the same language', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Markdown');
    await pasteText(page, 'note');
    await page.keyboard.press('ControlOrMeta+a');
    await expect.poll(async () => {
      await page.keyboard.press(blockCommentKey);
      const text = await editorText(page);
      if (text !== 'note') {
        await page.keyboard.press('ControlOrMeta+z');
      }
      return text;
    }, { timeout: 15_000 }).toBe('<!--~ note ~-->');
  });

  test('releases the configuration when the extension is removed', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');
    await pasteText(page, 'alpha');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press(blockCommentKey);
    await expect.poll(() => editorText(page)).toBe('/~ alpha ~/');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => editorText(page)).toBe('alpha');

    await runCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /Language Basics Fixture/ }).click();
    await expect(page.getByRole('option', { name: /Language Basics Fixture/ })).toHaveCount(0);
    await activeEditor(page).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press(blockCommentKey);
    await page.waitForTimeout(300);
    expect(await editorText(page)).toBe('alpha');
  });

  test('never reads a configuration path that leaves the extension folder', async ({ page }) => {
    const requests = recordRequests(page, /\/language-basics\/fixturelang-configuration\.json/);
    await openWithLanguageFixtures(page, ['broken/']);
    await newUntitled(page);
    await changeLanguage(page, 'Escaping Language');
    await page.waitForTimeout(1000);
    expect(requests).toEqual([]);
  });
});

/** The computed color of the first rendered token of the active editor whose text is `text`. */
async function tokenColor(page: Page, text: string): Promise<string> {
  const pattern = new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '[\\s\u00a0]') + '$');
  const token = activeGroup(page).locator('.monaco-editor .view-line span span').filter({ hasText: pattern }).first();
  await expect(token).toBeVisible();
  return token.evaluate(element => getComputedStyle(element).color);
}

const keywordColor = 'rgb(86, 156, 214)';
const commentColor = 'rgb(106, 153, 85)';
const numberColor = 'rgb(181, 206, 168)';
/** Monaco's own `vs-dark` comment color, which its JavaScript tokenizer uses: not the grammar theme's. */
const builtinCommentColor = 'rgb(96, 139, 78)';
const textMateRequests = /onig[^/]*\.wasm|vscode-textmate|vscode-oniguruma|textMateRuntime|\.tmLanguage(\.json)?(\?|$)/;

test.describe('TextMate grammars', () => {
  test('gives markdown headings, bold text, links and code fences the grammar\'s scopes', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Markdown');
    const scopesOf = async (line: string, text: string) =>
      (await tokenScopes(page, 'markdown', line))?.find(token => token.text === text)?.scopes ?? [];
    expect(await scopesOf('# Title', 'Title')).toEqual(['text.html.markdown', 'markup.heading.markdown', 'entity.name.section.markdown']);
    expect(await scopesOf('a **bold** b', 'bold')).toEqual(['text.html.markdown', 'markup.bold.markdown']);
    expect(await scopesOf('[site](https://example.com)', 'https://example.com'))
      .toEqual(['text.html.markdown', 'meta.link.inline.markdown', 'markup.underline.link.markdown']);
    expect(await scopesOf('```js', '```')).toEqual(['text.html.markdown', 'markup.fenced_code.block.markdown', 'punctuation.definition.markdown']);
  });

  test('colors with the theme\'s token colors, embedded code too, and leaves built-in tokenizers their colors', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');
    await pasteText(page, 'alpha "x" %% note');
    await expect.poll(() => tokenColor(page, 'alpha'), { timeout: 20_000 }).toBe(keywordColor);
    await expect.poll(() => tokenColor(page, '%% note')).toBe(commentColor);

    await newUntitled(page);
    await changeLanguage(page, 'Markdown');
    await pasteText(page, 'Text\n```fixturelang\nbeta\n```\n```unregistered\nalpha\n```');
    await expect.poll(() => tokenColor(page, 'beta'), { timeout: 20_000 }).toBe(keywordColor);
    await expect.poll(() => editorText(page)).toContain('```unregistered');

    await newUntitled(page);
    await changeLanguage(page, 'JavaScript');
    await pasteText(page, 'const x = 1; // c');
    await expect.poll(() => tokenColor(page, 'const')).toBe(keywordColor);
    await expect.poll(() => tokenColor(page, '1')).toBe(numberColor);
    await expect.poll(() => tokenColor(page, '// c')).toBe(builtinCommentColor);
  });

  test('fetches the engine, its WebAssembly and a grammar only once a language with a grammar is used', async ({ page }) => {
    const requests = recordRequests(page, textMateRequests);
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await page.keyboard.type('plain text');
    await page.waitForTimeout(1000);
    expect(requests).toEqual([]);

    await changeLanguage(page, 'Fixture Language');
    await expect.poll(() => requests.some(url => /onig[^/]*\.wasm/.test(url)), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => requests.some(url => url.endsWith('/language-basics/syntaxes/fixturelang.tmLanguage.json'))).toBe(true);
    expect(requests.some(url => url.includes('markdown.tmLanguage'))).toBe(false);
  });

  test('keeps typing on a line of 25,000 characters and colors the lines around it', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');
    await pasteText(page, 'beta\n' + 'alpha '.repeat(4167) + '\n');
    await expect.poll(() => tokenColor(page, 'beta'), { timeout: 20_000 }).toBe(keywordColor);
    await page.keyboard.press('ControlOrMeta+End');
    const started = Date.now();
    await page.keyboard.type('alpha');
    await expect.poll(() => tokenColor(page, 'alpha'), { timeout: 5_000 }).toBe(keywordColor);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // The missing grammar's 404 reaches the console, so this test does not fail on console errors.
  base('a missing, broken or plist grammar leaves the editor open and the text visible', async ({ page }) => {
    const escaping = recordRequests(page, /\/language-basics\/syntaxes\/fixturelang\.tmLanguage\.json/);
    await openWithLanguageFixtures(page, ['broken/']);
    for (const language of ['Broken Grammar Language', 'Missing Grammar Language', 'Plist Grammar Language', 'Escaping Language']) {
      await newUntitled(page);
      await changeLanguage(page, language);
      await page.keyboard.type('still here');
      await expect.poll(() => editorText(page)).toBe('still here');
    }
    expect(escaping).toEqual([]);
  });

  test('stops using an extension\'s grammar once it is removed', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Fixture Language');
    await pasteText(page, 'alpha');
    await expect.poll(() => tokenColor(page, 'alpha'), { timeout: 20_000 }).toBe(keywordColor);

    await runCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /Language Basics Fixture/ }).click();
    await expect.poll(() => tokenColor(page, 'alpha'), { timeout: 15_000 }).not.toBe(keywordColor);
  });
});

test.describe('snippets', () => {
  const suggestions = (page: Page) => activeGroup(page).locator('.suggest-widget');
  const snippetRow = (page: Page) => suggestions(page).getByRole('option').filter({ hasText: 'Insert bold text' });

  async function suggest(page: Page): Promise<void> {
    await page.keyboard.press('Control+Space');
    await expect(suggestions(page)).toBeVisible({ timeout: 15_000 });
  }

  test('offers a contributed snippet in its language, with tab stops, and not in plain text', async ({ page }) => {
    const reads = recordRequests(page, /\/language-basics\/snippets\/markdown\.code-snippets$/);
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await page.keyboard.type('bold');
    await suggest(page);
    await expect(snippetRow(page)).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await changeLanguage(page, 'Markdown');
    await page.waitForTimeout(500);
    expect(reads).toEqual([]);
    await page.keyboard.type('bold');
    await suggest(page);
    await expect(snippetRow(page)).toBeVisible();
    expect(reads).toHaveLength(1);
    await snippetRow(page).click();
    await expect.poll(() => editorText(page)).toBe('****');
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await page.keyboard.type('y');
    await expect.poll(() => editorText(page)).toBe('**x**y');
  });

  test('puts the selected text where the snippet says TM_SELECTED_TEXT', async ({ page }) => {
    await openWithLanguageFixtures(page);
    await newUntitled(page);
    await changeLanguage(page, 'Markdown');
    await pasteText(page, 'word');
    await expect.poll(() => editorText(page)).toBe('word');
    await activeEditor(page).focus();
    await page.keyboard.press('End');
    // Selected from the end back, so the cursor stands before the word and the list is not filtered by it.
    await page.keyboard.press('Shift+Home');
    await suggest(page);
    await snippetRow(page).click();
    await expect.poll(() => editorText(page)).toBe('**word**');
  });

  test('a broken snippet file of another extension does not hide these, and removal takes them away', async ({ page }) => {
    await openWithLanguageFixtures(page, ['', 'broken/']);
    await newUntitled(page);
    await changeLanguage(page, 'Markdown');
    await page.keyboard.type('bold');
    await suggest(page);
    await expect(snippetRow(page)).toHaveCount(1);
    await page.keyboard.press('Escape');

    await runCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /Language Basics Fixture/ }).click();
    await activeEditor(page).focus();
    await expect.poll(async () => {
      await page.keyboard.press('Escape');
      await suggest(page);
      return snippetRow(page).count();
    }, { timeout: 15_000 }).toBe(0);
  });
});
