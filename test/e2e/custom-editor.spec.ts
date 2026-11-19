import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { treeItem } from './explorer.helpers.js';
import {
  answerCloseQuestion, chooseOption, expectEditorText, focusEditorEnd, groups, readWorkspaceText, selectedTab, waitForStorage,
  writeWorkspaceFile,
} from './files.helpers.js';
import manifest from '../fixtures/extensions/custom-editor/package.json' with { type: 'json' };

const editorStateKey = 'writing-room:storage:1:memento/workbench.parts.editor';

const content = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

interface Probe {
  readonly activations: number;
  readonly closed: string[];
  readonly disposed: string[];
  readonly cancelled: boolean[];
  readonly lateResults: number;
  readonly activeTextEditor: boolean;
  readonly activeTab: string;
  readonly foreign: string;
  readonly second: string;
}

/** What the fixture extension saw, as it reports it in a notification. */
async function probe(page: Page): Promise<Probe> {
  const before = await page.getByText(/^Probe \{/).count();
  await command(page, 'Fixture: Probe Custom Editor');
  const message = page.getByText(/^Probe \{/);
  await expect(message).toHaveCount(before + 1);
  return JSON.parse((await message.last().textContent())!.slice('Probe '.length)) as Probe;
}

async function saveLayout(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
}

test.beforeEach(async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('custom-editor'), manifest }]);
});

test('opens a file in its default custom editor over the shared text document, waking the extension', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.note', 'hello');
  await treeItem(page, 'a.note').click();
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('a.note');
  await expect(content(page).locator('#text')).toHaveText('hello');
  await expect(content(page).locator('#shared')).toHaveText('shared document');

  const seen = await probe(page);
  expect(seen).toMatchObject({
    activations: 1, activeTextEditor: false, activeTab: 'custom fixture.noteView', foreign: 'refused', second: 'refused',
  });

  // Opening the same file again shows the editor that is open.
  await treeItem(page, 'a.note').click();
  await expect(page.getByRole('tab', { name: 'a.note' })).toHaveCount(1);
});

test('edits from the Webview reach the text editor beside it, with one dirty state, undo and save', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.md', '# a');
  await treeItem(page, 'a.md').click();
  const [left, right] = [groups(page).first(), groups(page).nth(1)];
  await expectEditorText(left, '# a');
  await command(page, 'Fixture: Open Preview Beside');
  await expect(groups(page)).toHaveCount(2);
  await expect(selectedTab(right)).toHaveText('a.md');
  const preview = content(page);
  await expect(preview.locator('#text')).toHaveText('# a');

  await preview.getByRole('button', { name: 'Append' }).click();
  await expectEditorText(left, '# a!');
  await expect(preview.locator('#text')).toHaveText('# a!');
  await expect(selectedTab(left)).toHaveAccessibleDescription('Modified');
  await expect(selectedTab(right)).toHaveAccessibleDescription('Modified');

  // The text editor's undo takes back the Webview's edit.
  await focusEditorEnd(page, left);
  await page.keyboard.press('ControlOrMeta+z');
  await expectEditorText(left, '# a');
  await expect(preview.locator('#text')).toHaveText('# a');
  await expect(selectedTab(right)).not.toHaveAccessibleDescription('Modified');

  await preview.getByRole('button', { name: 'Append' }).click();
  await expect(selectedTab(right)).toHaveAccessibleDescription('Modified');
  await selectedTab(right).click();
  await command(page, 'File: Save');
  await expect.poll(() => readWorkspaceText(page, 'a.md')).toBe('# a!');
  await expect(selectedTab(left)).not.toHaveAccessibleDescription('Modified');

  // Closing the text editor leaves the document open for the custom editor; closing both closes it.
  await left.getByRole('button', { name: 'Close a.md' }).click();
  await expect(left.getByRole('tab', { name: 'a.md' })).toHaveCount(0);
  expect((await probe(page)).closed).not.toContain('a.md');
  await page.getByRole('button', { name: 'Close a.md' }).click();
  await expect.poll(async () => (await probe(page)).closed).toContain('a.md');
  expect((await probe(page)).disposed).toEqual(['a.md']);
});

test('asks before a dirty custom editor closes alone, and Reopen With swaps editors in place keeping the text', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'other.txt', 'other');
  await writeWorkspaceFile(page, 'a.md', '# a');
  await treeItem(page, 'other.txt').click();
  await treeItem(page, 'a.md').click();
  const group = groups(page).first();
  await expectEditorText(group, '# a');

  await command(page, 'View: Reopen Editor With...');
  await expect(page.getByRole('option', { name: /^Text Editor/ })).toContainText('Active');
  await chooseOption(page, 'Fixture Preview');
  await expect(content(page).locator('#text')).toHaveText('# a');
  await expect(group.getByRole('tab')).toHaveText(['Welcome', 'other.txt', 'a.md']);
  await content(page).getByRole('button', { name: 'Append' }).click();
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  await command(page, 'View: Reopen Editor With...');
  await chooseOption(page, 'Text Editor');
  await expectEditorText(group, '# a!');
  await expect(group.getByRole('tab')).toHaveText(['Welcome', 'other.txt', 'a.md']);
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  await command(page, 'View: Reopen Editor With...');
  await chooseOption(page, 'Fixture Preview');
  await expect(content(page).locator('#text')).toHaveText('# a!');
  await page.getByRole('button', { name: 'Close a.md' }).click();
  await answerCloseQuestion(page, 'a.md', 'Cancel');
  await expect(selectedTab(group)).toHaveText('a.md');
  await page.getByRole('button', { name: 'Close a.md' }).click();
  await answerCloseQuestion(page, 'a.md', "Don't Save");
  await expect(group.getByRole('tab')).toHaveText(['Welcome', 'other.txt']);
  expect(await readWorkspaceText(page, 'a.md')).toBe('# a');
});

test('comes back after a reload and after a host restart, resolving when shown', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.note', 'kept');
  await writeWorkspaceFile(page, 'b.txt', 'b');
  await treeItem(page, 'a.note').click();
  await expect(content(page).locator('#text')).toHaveText('kept');
  await treeItem(page, 'b.txt').click();
  await saveLayout(page);
  expect(await page.evaluate(key => localStorage.getItem(key), editorStateKey)).toContain('fixture.noteView');

  await page.reload();
  const group = groups(page).first();
  await expect(group.getByRole('tab')).toHaveText(['Welcome', 'a.note', 'b.txt']);
  await expect(selectedTab(group)).toHaveText('b.txt');
  await group.getByRole('tab', { name: 'a.note' }).click();
  await expect(content(page).locator('#text')).toHaveText('kept');
  expect((await probe(page)).activations).toBe(1);

  // A new extension host resolves the editor again.
  await command(page, 'Restart Extension Host');
  await expect(content(page).locator('#text')).toHaveText('kept');
  expect(await probe(page)).toMatchObject({ activations: 1, activeTab: 'custom fixture.noteView' });
});

test('shows why a provider failed, and drops a resolution that ends after its editor closed', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'x.broken', 'x');
  await writeWorkspaceFile(page, 'y.slow', 'y');
  await writeWorkspaceFile(page, 'z.note', 'z');
  await treeItem(page, 'x.broken').click();
  await expect(page.getByText('The custom editor could not be opened: Fixture failure')).toBeVisible();

  await treeItem(page, 'y.slow').click();
  await expect(content(page).getByText('Waiting for release')).toBeVisible();
  await page.getByRole('button', { name: 'Close y.slow' }).click();
  await treeItem(page, 'z.note').click();
  await expect(content(page).locator('#text')).toHaveText('z');
  await command(page, 'Fixture: Release Slow Editor');
  await expect.poll(async () => (await probe(page)).lateResults).toBe(1);
  const seen = await probe(page);
  expect(seen.cancelled).toEqual([true]);
  expect(seen.disposed).toContain('y.slow');
  await expect(content(page).locator('#text')).toHaveText('z');
  await expect(content(page).getByText('Late result')).toHaveCount(0);
});
