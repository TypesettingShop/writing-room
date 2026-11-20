import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { explorerTree } from './explorer.helpers.js';
import { activeEditor, activeGroup, editorText, languageStatus, newUntitled, pasteText } from './language-basics.helpers.js';
import { hoverWidget, openFixtureEditor, openWithLanguageFeatures } from './language-features.helpers.js';

const chordPrefix = 'ControlOrMeta+k';

async function chord(page: Page, continuation: string): Promise<void> {
  await page.keyboard.press(chordPrefix);
  await page.keyboard.press(continuation);
}

test('trims trailing whitespace with the Monaco chord', async ({ appPage: page }) => {
  await newUntitled(page);
  await pasteText(page, 'first   \nsecond');
  await expect.poll(() => editorText(page)).toBe('first   \nsecond');

  await chord(page, 'ControlOrMeta+x');
  await expect.poll(() => editorText(page)).toBe('first\nsecond');
});

test('uses the workbench chord for language mode and Monaco chords for comments', async ({ appPage: page }) => {
  await newUntitled(page);
  await chord(page, 'm');
  const languages = page.getByRole('combobox');
  await expect(languages).toBeFocused();
  await languages.fill('JavaScript');
  await page.getByRole('option', { name: /^JavaScript\b/ }).first().click();
  await expect(languageStatus(page)).toHaveText('JavaScript');
  await activeEditor(page).focus();
  await pasteText(page, 'let count = 0;');
  await expect.poll(() => editorText(page)).toBe('let count = 0;');

  // Monaco loads the language's comment configuration on demand.
  await expect.poll(async () => {
    await chord(page, 'ControlOrMeta+c');
    return editorText(page);
  }, { intervals: [500] }).toBe('// let count = 0;');
  await chord(page, 'ControlOrMeta+u');
  await expect.poll(() => editorText(page)).toBe('let count = 0;');
});

test('folds and unfolds with Monaco chords', async ({ appPage: page }) => {
  await newUntitled(page);
  await pasteText(page, 'parent\n  child\nafter');
  await expect.poll(() => editorText(page)).toBe('parent\n  child\nafter');

  // The folding model computes ranges after the edit.
  await expect.poll(async () => {
    await chord(page, 'ControlOrMeta+0');
    return editorText(page);
  }, { intervals: [500] }).toBe('parent\nafter');
  await chord(page, 'ControlOrMeta+j');
  await expect.poll(() => editorText(page)).toBe('parent\n  child\nafter');
});

test('shows the hover at the caret with the Monaco chord', async ({ page }) => {
  await openWithLanguageFeatures(page);
  await openFixtureEditor(page);
  await pasteText(page, 'hoverme other');
  await expect.poll(() => editorText(page)).toBe('hoverme other');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');

  await chord(page, 'ControlOrMeta+i');
  await expect(hoverWidget(page).getByText('Fixture hover', { exact: true })).toBeVisible({ timeout: 10_000 });
});

test('keeps the workbench chord for closing the group', async ({ appPage: page }) => {
  await newUntitled(page);
  const tab = activeGroup(page).getByRole('tab', { name: 'Untitled-1' });
  await expect(tab).toBeVisible();

  await chord(page, 'w');
  await expect(tab).toHaveCount(0);
});

test('Escape cancels the chord and the next letter reaches the editor once', async ({ appPage: page }) => {
  await newUntitled(page);
  await chord(page, 'Escape');
  await page.keyboard.press('z');
  await expect.poll(() => editorText(page)).toBe('z');
});

test('does not trim the editor with focus in the Explorer', async ({ appPage: page }) => {
  await newUntitled(page);
  await pasteText(page, 'first   \nsecond');
  await expect.poll(() => editorText(page)).toBe('first   \nsecond');

  const explorer = explorerTree(page);
  await explorer.focus();
  await expect(explorer).toBeFocused();
  await chord(page, 'ControlOrMeta+x');
  await expect.poll(() => editorText(page)).toBe('first   \nsecond');
});

test('does not cut text in the find field or swallow the next letter', async ({ appPage: page }) => {
  await newUntitled(page);
  await page.keyboard.press('ControlOrMeta+f');
  const find = activeGroup(page).getByRole('textbox', { name: /^Find\b/ });
  await expect(find).toBeFocused();
  await find.fill('find me');
  await find.selectText();

  await chord(page, 'ControlOrMeta+x');
  await expect(find).toHaveValue('find me');
  await page.keyboard.press('z');
  await expect(find).toHaveValue('z');
});

test('does not start a Monaco chord for a continuation Monaco cannot decode', async ({ appPage: page }) => {
  await newUntitled(page);
  await page.keyboard.press(chordPrefix);
  // A synthetic event can have a physical code and no legacy keyCode for Monaco.
  await activeEditor(page).dispatchEvent('keydown', { code: 'KeyX', ctrlKey: true, bubbles: true, cancelable: true });
  await page.keyboard.press('z');
  await expect.poll(() => editorText(page)).toBe('z');
});
