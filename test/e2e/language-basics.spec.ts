import { expect, test } from './fixtures.js';
import {
  activeEditor, blockCommentKey, changeLanguage, editorText, languageStatus, message, newUntitled, openEditorContextMenu, openWithLanguageFixtures, pasteText,
  recordRequests, runCommand,
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
