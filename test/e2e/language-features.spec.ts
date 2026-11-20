import { readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { expect, test } from './fixtures.js';
import {
  actionMenu, actionNames, activeEditor, activeParameter, codeLens, editorMessage, editorText, expectSuggestDetails, followLink,
  hoverWidget, hoverWord, message, openActionMenu, openFixtureEditor, openQuickOutline, openWithLanguageFeatures, parameterHints, pasteText,
  renameInput, reportCompletions, reportEdits, reportSymbols, runCommand, suggestion, suggestionNames, suggestList, triggerSuggest,
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

test.describe('formatting', () => {
  test('formats the selected lines with the range formatter and the document with the document formatter', async ({ page }) => {
    const source = 'a  b\nfmt  fmt\nfmt c';
    await pasteText(page, source);
    await expect.poll(() => editorText(page)).toBe(source);
    // Select the second line after Monaco has applied the paste and placed its caret.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.press('ControlOrMeta+f');
    await expect.poll(() => editorText(page)).toBe('a  b\nFMT  FMT\nfmt c');
    await page.keyboard.press('Control+Shift+i');
    await expect.poll(() => editorText(page)).toBe('a b\nFMT FMT\nfmt c');
    expect(await reportEdits(page)).toMatch(/^Edits: formatted 1; ranges 1-1; options 4\/true;/);
  });

  test('drops a slow formatter\'s edits when the text changed before they arrived', async ({ page }) => {
    await pasteText(page, 'slowformat  x');
    await expect.poll(() => editorText(page)).toBe('slowformat  x');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Control+Shift+i');
    await page.keyboard.type('Z');
    await page.waitForTimeout(2500);
    expect(await reportEdits(page)).toMatch(/^Edits: formatted 1;/);
    await expect.poll(() => editorText(page)).toBe('slowformat  xZ');
  });
});

test.describe('code actions', () => {
  /** Puts the cursor in `teh` of `fix teh word`. */
  async function onTypo(page: import('@playwright/test').Page, lastLine = 'plain line'): Promise<void> {
    const text = 'fix teh word\n' + lastLine;
    await pasteText(page, text);
    await expect.poll(() => editorText(page)).toBe(text);
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowRight');
    }
  }

  test('lists the quick fixes for the fixture\'s own diagnostic, the preferred first; picking it edits, then runs its command', async ({ page }) => {
    await onTypo(page);
    await openActionMenu(page);
    // Monaco adds the group's name.
    await expect.poll(() => actionNames(page)).toEqual(['Fix typo: the, Quick Fix', 'Replace with ten, Quick Fix', 'Stale fix, Quick Fix']);
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('fix the word\nplain line');
    await expect(message(page, 'Fixed by command: kept')).toBeVisible({ timeout: 10_000 });
  });

  test('an edit computed for an older version is refused and its command does not run', async ({ page }) => {
    await onTypo(page);
    await openActionMenu(page);
    await actionMenu(page).getByRole('option', { name: 'Stale fix' }).click();
    // The fixture changed the document before giving the edit: only its own change is there.
    await expect.poll(() => editorText(page)).toBe('#fix teh word\nplain line');
    await expect(message(page, 'The code action could not be applied')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await expect(message(page, /^Fixed by command/)).toHaveCount(0);
    expect(await editorText(page)).toBe('#fix teh word\nplain line');
  });

  test('a kind asked for shows only actions of that kind, and a disabled action shows its reason', async ({ page }) => {
    await onTypo(page);
    // Refactor...: the provider offers a source action and a quick fix too, which do not show.
    await openActionMenu(page, 'ControlOrMeta+Shift+r');
    await expect.poll(() => actionNames(page)).toEqual([expect.stringMatching(/^Extract fixture block, Extract, Disabled/)]);
    await page.keyboard.press('Escape');
    expect(await reportEdits(page)).toContain('only refactor;');
    // Organize Imports applies the only action of its kind; a disabled one shows why instead.
    await page.keyboard.press('Shift+Alt+o');
    await expect(editorMessage(page, 'Nothing to organize in the fixture')).toBeVisible({ timeout: 10_000 });
    expect(await editorText(page)).toBe('fix teh word\nplain line');
  });

  test('a second quick fix request can cancel a pending request without a page error', async ({ page }) => {
    await onTypo(page, 'slowaction');
    await page.keyboard.press('ControlOrMeta+.');
    await expect(message(page, 'Slow code action started')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('ControlOrMeta+.');
    await expect(actionMenu(page)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => actionNames(page)).toContain('Fix typo: the, Quick Fix');
  });

  test('removing a provider cancels a pending quick fix request without a page error', async ({ page }) => {
    await onTypo(page, 'slowaction');
    await page.keyboard.press('ControlOrMeta+.');
    await expect(message(page, 'Slow code action started')).toBeVisible({ timeout: 10_000 });
    await runCommand(page, 'Language Features: Unregister Providers');
    await activeEditor(page).focus();
    // Wait past the pending provider's delay to catch a menu from a request that completed.
    await page.waitForTimeout(1500);
    await expect(actionMenu(page)).toBeHidden();
  });

  test('the extension host lets go of the actions once the light bulb has moved on', async ({ page }) => {
    await onTypo(page);
    await openActionMenu(page);
    await page.keyboard.press('Escape');
    await expect(actionMenu(page)).toBeHidden();
    // To a line without diagnostics: the light bulb's actions there are none.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(1500);
    await expect.poll(() => reportEdits(page), { timeout: 15_000 }).toMatch(/code actions cached 0$/);
  });

  test('a provider that is taken away offers no actions, and offers them again when registered again', async ({ page }) => {
    await onTypo(page);
    await openActionMenu(page);
    await page.keyboard.press('Escape');
    await runCommand(page, 'Language Features: Unregister Providers');
    await activeEditor(page).focus();
    await page.keyboard.press('ControlOrMeta+.');
    await page.waitForTimeout(1500);
    await expect(actionMenu(page)).toBeHidden();
    await runCommand(page, 'Language Features: Register Providers');
    await activeEditor(page).focus();
    await openActionMenu(page);
    await expect.poll(() => actionNames(page)).toContain('Fix typo: the, Quick Fix');
  });
});

test.describe('rename', () => {
  test('starts from the provider\'s placeholder and renames in the editor and in a file that is not open', async ({ page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'renamed.lft', 'oldName in a file\noldName again\n');
    await activeEditor(page).focus();
    await pasteText(page, 'call oldName here');
    await expect.poll(() => editorText(page)).toBe('call oldName here');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowRight');
    }
    await expect.poll(async () => {
      if (!await renameInput(page).isVisible()) {
        await page.keyboard.press('F2');
      }
      return renameInput(page).isVisible({ timeout: 1000 }).catch(() => false);
    }, { timeout: 20_000, intervals: [500, 1000] }).toBe(true);
    await expect(renameInput(page)).toHaveValue('oldNamePlaceholder');
    await renameInput(page).fill('newName');
    await page.keyboard.press('Enter');
    await expect.poll(() => editorText(page)).toBe('call newName here');
    await expect.poll(() => readWorkspaceText(page, 'renamed.lft'), { timeout: 15_000 }).toBe('newName in a file\nnewName again\n');
  });

  test('shows the provider\'s refusal', async ({ page }) => {
    await pasteText(page, 'locked');
    await page.keyboard.press('Home');
    await expect.poll(async () => {
      await page.keyboard.press('F2');
      return editorMessage(page, 'The fixture cannot rename locked').isVisible({ timeout: 1000 }).catch(() => false);
    }, { timeout: 20_000, intervals: [500, 1000] }).toBe(true);
    await expect(renameInput(page)).toBeHidden();
  });
});

test.describe('navigation', () => {
  test('the quick outline lists the headings, and vscode.executeDocumentSymbolProvider gives their tree as DocumentSymbols', async ({ page }) => {
    await pasteText(page, '# Title\ntext\n## Inner\n### Deeper\n## Second');
    const options = await openQuickOutline(page);
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveAccessibleName('Title (string), symbols (4)');
    await expect(options.nth(1)).toHaveAccessibleName('Inner (string)');
    await expect(options.nth(2)).toHaveAccessibleName('Deeper (string)');
    await expect(options.nth(3)).toHaveAccessibleName('Second (string)');
    await page.keyboard.press('Escape');
    await expect.poll(() => reportSymbols(page), { timeout: 20_000 }).toBe('Symbols: Title(Inner(Deeper) Second); DocumentSymbol true');
  });

  test('links are underlined; a workspace link opens its file at the line, an external one asks first, another extension\'s command does not run', async ({ page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'linked.lft', 'first line\nsecond line\n');
    await pasteText(page, '[[linked.lft]]\n{external}\n{other}\n{run}');
    await followLink(page, '{other}');
    const blockedCommand = page.getByRole('region', { name: /is not one its extension contributes/ });
    await expect(blockedCommand).toBeVisible({ timeout: 10_000 });
    await expect(selectedTab(page.locator('[data-group-id].active'))).toHaveText(/Untitled-1/);
    await blockedCommand.getByRole('button', { name: 'Dismiss message' }).click();
    // The fixture's own command runs.
    await followLink(page, '{run}');
    await expect(message(page, 'Lens ran: link')).toBeVisible({ timeout: 10_000 });
    await followLink(page, '{external}');
    const question = page.getByRole('option', { name: /^Cancel/ });
    await expect(page.getByText('Do you want to open this external address?')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('option', { name: /^Open/ })).toContainText('https://example.com/');
    await question.click();
    await followLink(page, '[[linked.lft]]');
    await expect(selectedTab(page.locator('[data-group-id].active'))).toHaveText(/linked\.lft/, { timeout: 15_000 });
    await expect.poll(() => editorText(page)).toBe('first line\nsecond line');
    await page.keyboard.press('Home');
    await page.keyboard.type('X');
    await expect.poll(() => editorText(page)).toBe('first line\nXsecond line');
  });

  test('goes to a definition in another file, which opens in an editor', async ({ page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'defs.lft', 'first\ndef target here\n');
    await pasteText(page, 'use target now');
    await expect.poll(() => editorText(page)).toBe('use target now');
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 'use t'.length; i++) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('F12');
    await expect(selectedTab(page.locator('[data-group-id].active'))).toHaveText(/defs\.lft/, { timeout: 15_000 });
    await expect.poll(() => editorText(page)).toBe('first\ndef target here');
    await page.keyboard.press('Home');
    await page.keyboard.type('X');
    await expect.poll(() => editorText(page)).toBe('first\nXdef target here');
  });

  test('folds the provider\'s range: the lines after begin up to the one before end hide, no line more or less', async ({ page }) => {
    await pasteText(page, 'begin\ninside one\ninside two\nend\nafter');
    await page.keyboard.press('ControlOrMeta+Home');
    await expect.poll(async () => {
      await page.keyboard.press('ControlOrMeta+Shift+BracketLeft');
      return editorText(page);
    }, { timeout: 20_000, intervals: [1000] }).toBe('begin\nend\nafter');
    await page.keyboard.press('ControlOrMeta+Shift+BracketRight');
    await expect.poll(() => editorText(page)).toBe('begin\ninside one\ninside two\nend\nafter');
  });

  test('a code lens runs its command, and after the provider\'s change event shows the new lenses', async ({ page }) => {
    await pasteText(page, '# Alpha\ntext\n# Beta');
    await expect(codeLens(page, 'Lens 1: Alpha')).toBeVisible({ timeout: 20_000 });
    await codeLens(page, 'Lens 1: Beta').click();
    await expect(message(page, 'Lens ran: Beta')).toBeVisible({ timeout: 10_000 });
    await runCommand(page, 'Language Features: Change Code Lenses');
    await expect(codeLens(page, 'Lens 2: Alpha')).toBeVisible({ timeout: 20_000 });
    await expect(codeLens(page, /^Lens 1:/)).toHaveCount(0);
  });
});
