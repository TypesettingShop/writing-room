// Acceptance (wr-jbmd.xwh): the real Open VSX package `DavidAnson.vscode-markdownlint` 0.62.1 and, as the floor,
// `Tyriar.sort-lines` 1.12.0, installed unchanged from the Extensions view out of the fixture gallery
// (test/fixtures/routes/openvsx.mjs serves the pinned, signed cache). markdownlint: diagnostics, quick fixes, range
// formatting, settings, the workspace's configuration file, the output channel, a command, a reload and removal.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { startWithMarkdownSource } from './configuration.helpers.js';
import { problemNames, problemsStatus, openProblemsCommand } from './diagnostics.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { activeGroup, editorText as renderedEditorText, openEditorContextMenu, runCommand } from './language-basics.helpers.js';
import { actionNames, hoverWidget, openActionMenu } from './language-features.helpers.js';
import { openSettings as openUserSettings, replaceText, saveSettings } from './configuration.helpers.js';
import { packageFolders, savedRecords } from './packages.helpers.js';
import {
  installFromGallery, installedExtensions, openExtensions, realPin, requireRealExtensions, routeFixtureGallery, uninstallButton,
} from './real-extensions.helpers.js';
import { outputView } from './window-ui.helpers.js';

test.beforeEach(async ({ page }) => {
  await startWithMarkdownSource(page);
});

test.use({ viewport: { width: 1280, height: 800 } });

/**
 * The messages logged under the two extensions' ids, exactly. markdownlint contributes four kinds the workbench does
 * not support (schemas for its configuration files, a task type and a problem matcher); that is said once, as info.
 * sort-lines says nothing.
 */
const allowedMessages = [
  'info: [davidanson.vscode-markdownlint] contributes: Unsupported contributions: jsonValidation, yamlValidation, taskDefinitions, problemMatchers',
];

const notes = '# Title\n\n##Bad heading\n\nTrailing spaces   \n\nTwo blanks follow\n\n\nEnd\n';
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const line = (page: Page, text: string) => activeGroup(page).locator('.view-line').filter({ hasText: text }).first();
/**
 * The editor's text without its blank lines, which Monaco renders as empty rows that the rendered text does not keep,
 * and with the dots it draws for selected spaces made plain (U+00B7, or U+2E31 when the font's middle dot is the wider).
 */
const editorText = async (page: Page) => (await renderedEditorText(page)).replace(/[\u00b7\u2e31]/g, ' ').split('\n').filter(row => row !== '').join('\n');
const squash = (text: string) => text.split('\n').filter(row => row !== '').join('\n');
const lintName = /^Uninstall markdownlint/;
const sortName = /^Uninstall Sort Lines/i;

/** The rule codes of the Problems rows, in display order (the file's header row has none). */
async function rules(page: Page): Promise<string[]> {
  return (await problemNames(page)).flatMap(name => /markdownlint\((MD\d+)\)/.exec(name ?? '')?.[1] ?? []);
}

async function showProblems(page: Page): Promise<void> {
  // Right after a reload the palette can open before its commands are registered: asked again until the entry shows.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('F1');
    await page.getByRole('combobox').fill(openProblemsCommand, { timeout: 5_000 });
    await page.getByRole('option', { name: openProblemsCommand, exact: true }).click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(outputView(page).panel.getByRole('tab', { name: 'Problems' })).toHaveAttribute('aria-selected', 'true');
}

async function show(page: Page, name: string): Promise<void> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/** Types a character and takes it back: the one edit that makes the extension look at the document. */
async function touch(page: Page): Promise<void> {
  await line(page, 'End').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  // Saving makes a document lint under both values of markdownlint.run.
  await page.keyboard.press('ControlOrMeta+s');
}

/**
 * The Problems rows are expected to follow an event with no edit of the document (the extension came, a configuration
 * file or a setting changed, the page reloaded): the extension lints the visible editors again. When that does not
 * happen the soft expectation records it, and a touch of the document lets the steps after it run.
 */
async function expectRelint(page: Page, expected: string[], reason: string): Promise<void> {
  await expect.configure({ soft: true }).poll(() => rules(page), { message: reason, timeout: 10_000 }).toEqual(expected);
  if (JSON.stringify(await rules(page)) !== JSON.stringify(expected)) {
    await touch(page);
  }
  await expect.poll(() => rules(page), { timeout: 20_000 }).toEqual(expected);
}

test('installs markdownlint and sort-lines from the gallery, uses them, keeps markdownlint over a reload and removes both', async ({ page }) => {
  requireRealExtensions();
  test.setTimeout(420_000);
  const lintPin = await realPin('DavidAnson.vscode-markdownlint');
  const sortPin = await realPin('Tyriar.sort-lines');
  const messages: string[] = [];
  page.on('console', message => {
    if (/^\[(davidanson\.vscode-markdownlint|tyriar\.sort-lines)\]/i.test(message.text())) {
      messages.push(message.type() + ': ' + message.text());
    }
  });
  await routeFixtureGallery(page);

  await test.step('Install markdownlint from the Extensions view: the pinned, signed package', async () => {
    await page.goto('/');
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'notes.md', notes);
    await treeItem(page, 'notes.md').dblclick();
    await expect(tab(page, 'notes.md')).toBeVisible();
    const confirmation = await installFromGallery(page, 'markdownlint', 'markdownlint', lintName);
    expect(confirmation).toContain('DavidAnson · 0.62.1 · davidanson.vscode-markdownlint');
    expect(confirmation).toContain('Web extension');
    expect(confirmation).toContain('Source: open-vsx.org');
    expect(confirmation).toContain('SHA-256: ' + lintPin.vsix.sha256);
    expect(confirmation).toContain(`Signature: verified (${lintPin.publicKey})`);
    await expect(installedExtensions(page).getByRole('listitem').filter({ hasText: 'davidanson.vscode-markdownlint · 0.62.1 · Open VSX' })).toBeVisible();
    expect(await savedRecords(page)).toEqual([expect.objectContaining({
      identifier: 'davidanson.vscode-markdownlint', version: '0.62.1', source: 'gallery', signature: 'verified', packageSha256: lintPin.vsix.sha256,
    })]);
    expect((await packageFolders(page)).some(path => path.startsWith('/extensions/davidanson.vscode-markdownlint-0.62.1/'))).toBe(true);
  });

  await test.step('Diagnostics: squiggles, Problems rows and count, the status bar, the hover', async () => {
    await showProblems(page);
    // The document was open before the extension came; a document with violations has diagnostics without an edit.
    await expectRelint(page, ['MD018', 'MD009', 'MD012'], 'a document that was open when the extension came is linted');
    expect((await problemNames(page))[0]).toMatch(/^notes\.md .*3 problems$/);
    await expect(problemsStatus(page, '0 errors, 3 warnings')).toBeVisible();
    await expect(activeGroup(page).locator('.squiggly-warning').first()).toBeVisible();
    expect(await activeGroup(page).locator('.squiggly-warning').count()).toBeGreaterThanOrEqual(3);
    // Rested on again until the hover shows: on a busy machine the first rest can end before the hover's delay.
    await expect.poll(async () => {
      if (!await hoverWidget(page).isVisible()) {
        await page.mouse.move(0, 0);
        await line(page, '##Bad').hover({ position: { x: 8, y: 5 } });
      }
      return hoverWidget(page).innerText({ timeout: 2_000 }).catch(() => '');
    }, { timeout: 20_000, intervals: [1_000] }).toContain('MD018/no-missing-space-atx');
    await page.mouse.move(0, 0);
  });

  await test.step('A quick fix and a range format, each undone by one undo', async () => {
    await line(page, '##Bad').click({ position: { x: 8, y: 5 } });
    await openActionMenu(page);
    const names = await actionNames(page);
    expect.soft(names, 'the quick fix of the violation under the cursor').toContain('Fix this violation of MD018/no-missing-space-atx, Quick Fix');
    if (names.includes('Fix this violation of MD018/no-missing-space-atx, Quick Fix')) {
      await page.getByRole('listbox', { name: 'Action Widget' }).getByRole('option', { name: /^Fix this violation of MD018/ }).click();
    } else {
      // Carries on with the same edit by hand, so that the steps below have their text.
      await page.keyboard.press('Escape');
      await line(page, '##Bad').click({ position: { x: 8, y: 5 } });
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type(' ');
    }
    await expect.poll(() => editorText(page)).toBe(squash(notes.replace('##Bad', '## Bad')));
    await expect.poll(() => rules(page), { timeout: 20_000 }).toEqual(['MD009', 'MD012']);

    // Range formatting fixes the violations inside the selection: line 5, not the blank lines of line 9.
    const before = await editorText(page);
    await line(page, 'Trailing').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.press('ControlOrMeta+f');
    await expect.poll(() => editorText(page)).toBe(before.replace('Trailing spaces   ', 'Trailing spaces'));
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => editorText(page)).toBe(before);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(() => editorText(page)).toBe(before.replace('Trailing spaces   ', 'Trailing spaces'));
    await expect.poll(() => rules(page), { timeout: 20_000 }).toEqual(['MD012']);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => rules(page), { timeout: 20_000 }).toEqual(['MD009', 'MD012']);
  });

  await test.step('A configuration file in the workspace turns a rule off', async () => {
    await writeWorkspaceFile(page, '.markdownlint.json', '{ "MD012": false }\n');
    await expectRelint(page, ['MD009'], 'a changed configuration file lints the open document again');
    await expect(problemsStatus(page, '0 errors, 1 warning')).toBeVisible();
  });

  await test.step('markdownlint.run = onSave: typing does not lint again, saving does', async () => {
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await openUserSettings(page);
    await replaceText(page, '{ "markdownlint.run": "onSave" }\n');
    await saveSettings(page);
    await show(page, 'notes.md');
    await expectRelint(page, ['MD009'], 'a changed setting lints the open document again');
    await line(page, 'Two blanks').click();
    await page.keyboard.press('End');
    await page.keyboard.type('   ');
    await expect.poll(() => editorText(page)).toContain('follow   \nEnd');
    // Nothing can be waited for here: the extension lints a typed document 500 ms after the last key.
    await page.waitForTimeout(1500);
    expect(await rules(page)).toEqual(['MD009']);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(tab(page, 'notes.md')).not.toHaveAccessibleDescription('Modified');
    await expect.poll(() => problemNames(page), { timeout: 20_000 }).toEqual([
      expect.stringMatching(/2 problems$/),
      expect.stringContaining('MD009'),
      expect.stringContaining('MD009'),
    ]);
    // Back to the default, so that the reload below lints as it is typed.
    await show(page, 'settings.json');
    await replaceText(page, '{}\n');
    await saveSettings(page);
    await show(page, 'notes.md');
  });

  await test.step('The output channel has lines; the toggle command silences the diagnostics', async () => {
    const { panel, tab: outputTab, channels, log } = outputView(page);
    await outputTab.click();
    await channels.getByRole('option', { name: 'markdownlint' }).click();
    await expect(log).toContainText('Linting for "vscode-vfs://writing-room/workspace/notes.md"');
    await panel.getByRole('tab', { name: 'Problems' }).click();
    await runCommand(page, 'markdownlint: Toggle linting on/off (temporarily)');
    await expect.poll(() => problemNames(page), { timeout: 20_000 }).not.toContainEqual(expect.stringContaining('markdownlint('));
    await expect(problemsStatus(page, '0 errors, 0 warnings')).toBeVisible();
  });

  await test.step('Reload: the extension is registered again and the open document is linted', async () => {
    await page.reload();
    await expect(tab(page, 'notes.md')).toBeVisible({ timeout: 20_000 });
    await show(page, 'notes.md');
    await showProblems(page);
    await expectRelint(page, ['MD009', 'MD009'], 'the open document is linted after a reload');
  });

  await test.step('Remove markdownlint: no diagnostics, no channel, no command, no record, no package', async () => {
    await openExtensions(page);
    await uninstallButton(page, lintName).click();
    await expect(uninstallButton(page, lintName)).toHaveCount(0);
    await expect.poll(() => savedRecords(page)).toEqual([]);
    await expect.poll(() => packageFolders(page)).toEqual([]);
    await expect(problemsStatus(page, '0 errors, 0 warnings')).toBeVisible();
    await showProblems(page);
    await expect.poll(() => rules(page)).toEqual([]);
    const { tab: outputTab, channels, log } = outputView(page);
    await outputTab.click();
    // markdownlint's own dispose callback clears its diagnostic collection after that collection was disposed (its order,
    // as in VS Code). The workbench keeps the extension's cleanup error in the extension host log, not in the console
    // (wr-54me). Lines of the extension's timers after removal are not asserted: whether one fires is timing.
    await channels.getByRole('option', { name: 'Extension Host (Worker)' }).click();
    // The channel list is drawn now, so its missing entry is a fact rather than a list not shown yet.
    await expect(channels.getByRole('option', { name: 'markdownlint' })).toHaveCount(0);
    // The error is the one of that disposal: it follows the extension's line, not some other line of the log.
    await expect(log).toContainText(
      /\[davidanson\.vscode-markdownlint\] Subscription disposal failed: [\s\S]*?illegal state - object is disposed/);
    // A command that is still there would show: first a query the list must show (a built-in command), then the one it
    // must not, read once the first query's entry has gone from the list.
    await page.keyboard.press('F1');
    await page.getByRole('combobox').fill('Focus Problems');
    await expect(page.getByRole('option', { name: /Focus Problems/ })).toBeVisible();
    await page.getByRole('combobox').fill('markdownlint: Toggle');
    await expect(page.getByRole('option', { name: /Focus Problems/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /markdownlint/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('sort-lines: F9 and the editor context menu sort the selected lines', async () => {
    await page.keyboard.press('ControlOrMeta+Shift+e');
    await writeWorkspaceFile(page, 'sort.md', 'pear\napple\nbanana');
    await treeItem(page, 'sort.md').dblclick();
    await expect(tab(page, 'sort.md')).toHaveAttribute('aria-selected', 'true');
    const confirmation = await installFromGallery(page, 'sort-lines', 'Sort lines', sortName);
    expect(confirmation).toContain('Tyriar · 1.12.0 · tyriar.sort-lines');
    expect(confirmation).toContain('SHA-256: ' + sortPin.vsix.sha256);
    expect(confirmation).toContain(`Signature: verified (${sortPin.publicKey})`);
    await show(page, 'sort.md');
    const selectAll = async () => {
      await line(page, 'pear').click();
      await page.keyboard.press('ControlOrMeta+a');
    };
    await selectAll();
    // The command exists once the extension has activated, so the key is pressed until the text changes or the time is up.
    const sorted = 'apple\nbanana\npear';
    await expect.configure({ soft: true }).poll(async () => {
      await page.keyboard.press('F9');
      return editorText(page);
    }, { message: 'F9 of the extension sorts the selected lines', timeout: 10_000 }).toBe(sorted);
    if (await editorText(page) !== sorted) {
      // The command itself, to see whether the key or the command is what fails.
      await runCommand(page, 'Sort lines (ascending, case sensitive)');
      await expect.configure({ soft: true }).poll(() => editorText(page), { message: 'the command of the extension sorts the selected lines', timeout: 5_000 }).toBe(sorted);
    }
    const original = 'pear\napple\nbanana';
    // F9 was pressed until the text changed: while the extension activated, one press can land after the sort and sort
    // again (an edit that changes nothing visible), so undo until the original text is back.
    await expect.poll(async () => {
      const text = await editorText(page);
      if (text !== original) {
        await page.keyboard.press('ControlOrMeta+z');
      }
      return text;
    }, { intervals: [300] }).toBe(original);
    await selectAll();
    await openEditorContextMenu(page);
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Sort lines (ascending, case sensitive)' }) });
    await expect(menu).toBeVisible();
    // The entries are contributed with `editorTextFocus && !editorReadonly`; no read-only editor can be made here (the
    // workbench has no command for one and the files are all writable), so only the shown side of the condition is checked.
    // Monaco's context menu ignores a pointer release for 100 ms after it opens (as in documents.spec.ts).
    await menu.getByRole('menuitem', { name: 'Sort lines (ascending, case sensitive)', exact: true }).click({ delay: 150 });
    await expect.configure({ soft: true }).poll(() => editorText(page), { message: 'the context menu entry sorts the selected lines', timeout: 10_000 }).toBe(sorted);
  });

  await test.step('sort-lines: removed', async () => {
    await openExtensions(page);
    await uninstallButton(page, sortName).click();
    await expect(uninstallButton(page, sortName)).toHaveCount(0);
    await expect.poll(() => savedRecords(page)).toEqual([]);
    await expect.poll(() => packageFolders(page)).toEqual([]);
  });

  // Each start of the extension host (the install, the reload) logs the notice again: every message is an allowed one,
  // and each allowed one shows.
  expect([...new Set(messages)].sort()).toEqual([...allowedMessages].sort());
});
