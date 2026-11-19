import { expect, test } from './fixtures.js';
import {
  activeEditor, activeParameter, editorText, expectSuggestDetails, hoverWidget, hoverWord, message, openFixtureEditor, openWithLanguageFeatures,
  parameterHints, pasteText, reportCompletions, runCommand, suggestion, suggestionNames, suggestList, triggerSuggest,
} from './language-features.helpers.js';

test.beforeEach(async ({ page }) => {
  await openWithLanguageFeatures(page);
  await openFixtureEditor(page);
});

test.describe('completions', () => {
  test('shows the items with their labels, kinds and order; a snippet has tab stops', async ({ page }) => {
    await pasteText(page, 'fixture');
    await page.keyboard.press('End');
    await triggerSuggest(page);
    await expect.poll(() => suggestionNames(page)).toEqual([
      'fixtureSnippet, Snippet', 'fixtureCommand, runs a command, Function', 'fixtureKey, Keyword', 'fixtureReplace, Variable',
    ]);
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('snip(first, second)');
    // The first tab stop is selected, then the second.
    await page.keyboard.type('1');
    await page.keyboard.press('Tab');
    await page.keyboard.type('2');
    await expect.poll(() => editorText(page)).toBe('snip(1, 2)');
  });

  test('applies the additional edits and runs the item\'s command with its original arguments', async ({ page }) => {
    await pasteText(page, 'fixtureCo');
    await page.keyboard.press('End');
    await triggerSuggest(page);
    await expect(suggestion(page, 'fixtureCommand')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('import;\nfixtureCommand');
    await expect(message(page, 'Accepted: function kept from-item')).toBeVisible({ timeout: 10_000 });
  });

  test('inserts up to the cursor with Enter and replaces with Shift+Enter, as the item\'s ranges say', async ({ page }) => {
    await pasteText(page, 'fixtureRest tail');
    await page.keyboard.press('Home');
    for (let i = 0; i < 'fixtureRe'.length; i++) {
      await page.keyboard.press('ArrowRight');
    }
    await triggerSuggest(page);
    await expect(suggestion(page, 'fixtureReplace')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('fixtureReplacest tail');

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => editorText(page)).toBe('fixtureRest tail');
    await triggerSuggest(page);
    await expect(suggestion(page, 'fixtureReplace')).toBeVisible();
    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => editorText(page)).toBe('fixtureReplace');
  });

  test('a commit character accepts the item, a trigger character asks for suggestions', async ({ page }) => {
    await pasteText(page, 'fixtureK');
    await page.keyboard.press('End');
    await triggerSuggest(page);
    await expect(suggestion(page, 'fixtureKey')).toBeVisible();
    await page.keyboard.type('(');
    await expect.poll(() => editorText(page)).toBe('fixtureKey(');

    await page.keyboard.press('Escape');
    await page.keyboard.type(' obj');
    await page.keyboard.press('Escape');
    // A dot is no word character: only the provider's trigger character opens the list here.
    await page.keyboard.type('.');
    await expect(suggestion(page, 'dotMember')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => suggestionNames(page)).toEqual(['dotMember, Field']);
  });

  test('an incomplete list is asked again as the word grows', async ({ page }) => {
    await pasteText(page, 'inc');
    await page.keyboard.press('End');
    await triggerSuggest(page);
    await expect(suggestion(page, 'incomplete3')).toBeVisible();
    await page.keyboard.type('o');
    await expect(suggestion(page, 'incomplete4')).toBeVisible({ timeout: 10_000 });
    await expect(suggestion(page, 'incomplete3')).toHaveCount(0);
  });

  test('resolves each item once and shows its documentation; the extension host lets the list go when the widget closes', async ({ page }) => {
    await pasteText(page, 'fixture');
    await page.keyboard.press('End');
    await triggerSuggest(page);
    await expectSuggestDetails(page, 'Resolved fixtureSnippet');
    await page.keyboard.press('ArrowDown');
    await expectSuggestDetails(page, 'Resolved fixtureCommand');
    await page.keyboard.press('ArrowDown');
    await expectSuggestDetails(page, 'Resolved fixtureKey');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expectSuggestDetails(page, 'Resolved fixtureSnippet');
    await page.keyboard.press('Escape');
    await expect(suggestList(page)).toBeHidden();
    await page.waitForTimeout(500);
    expect(await reportCompletions(page)).toMatch(/^Resolved: fixtureSnippet=1, fixtureCommand=1, fixtureKey=1; cache while open: [1-9]\d*; cache now: 0;/);
  });

  test('fast typing never shows the list of the request it cancelled', async ({ page }) => {
    // The request at `slow.` answers late; the one at `slow.x.` asked after it and answers at once.
    await page.keyboard.type('slow.x.', { delay: 50 });
    await expect(suggestion(page, 'freshResult')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    await expect.poll(() => suggestionNames(page)).toEqual(['freshResult, Field']);
  });

  test('a provider that is taken away offers nothing, and comes back when registered again', async ({ page }) => {
    await runCommand(page, 'Language Features: Unregister Providers');
    await activeEditor(page).focus();
    await pasteText(page, 'fixture');
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(1000);
    await expect(suggestion(page, 'fixtureSnippet')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await runCommand(page, 'Language Features: Register Providers');
    await activeEditor(page).focus();
    await triggerSuggest(page);
    await expect(suggestion(page, 'fixtureSnippet')).toBeVisible();
  });
});

test.describe('hover', () => {
  test('shows every provider\'s hover; an untrusted command link and its HTML do nothing', async ({ page }) => {
    await pasteText(page, 'hoverme other');
    await hoverWord(page, 'hoverme');
    await expect(hoverWidget(page).getByText('Fixture hover', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(hoverWidget(page).getByText('Second hover', { exact: true })).toBeVisible();
    await expect(hoverWidget(page).getByText('fixture code block')).toBeVisible();
    await hoverWidget(page).getByText('Run hover command').click();
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as unknown as { lfHoverScript?: number }).lfHoverScript)).toBeUndefined();
    await expect(message(page, 'Hover command ran')).toHaveCount(0);
    await activeEditor(page).focus();
    expect(await reportCompletions(page)).toContain('hover commands: 0');
  });
});

test.describe('signature help', () => {
  test('marks the active parameter as the arguments are typed', async ({ page }) => {
    await pasteText(page, 'snip');
    await page.keyboard.press('End');
    await page.keyboard.type('(');
    await expect(parameterHints(page)).toBeVisible({ timeout: 10_000 });
    await expect(parameterHints(page)).toContainText('snip(first, second)');
    await expect(activeParameter(page)).toHaveText('first');
    await page.keyboard.type('a,');
    await expect(activeParameter(page)).toHaveText('second');
    await expect(parameterHints(page)).toContainText('The second.');
  });
});
