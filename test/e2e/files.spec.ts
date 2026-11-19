import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, renderedText, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import type { InstalledExtensionFixture } from './extensionFixture.js';
import {
  answerCloseQuestion, chooseOption, deleteWorkspaceFile, expectEditorText, fileMenu, focusEditorEnd, groups, listBackups,
  openFilesByRestore, quickInputBox, quickPick, readWorkspaceBytes, readWorkspaceText, selectedTab, waitForStorage,
  writeWorkspaceFile,
} from './files.helpers.js';

test.use({ viewport: { width: 1280, height: 800 } });

/** Seeds `files` and opens the first one, as a restored editor. */
async function open(page: Page, files: Record<string, string>, folders: string[] = []): Promise<void> {
  await waitForStorage(page);
  let first = true;
  for (const [path, content] of Object.entries(files)) {
    await writeWorkspaceFile(page, path, content, first ? folders : []);
    first = false;
  }
  await openFilesByRestore(page, Object.keys(files));
}

const save = (page: Page) => page.keyboard.press('ControlOrMeta+s');

test('opens a file, saves it with Ctrl+S, and shows the saved text after reload', async ({ appPage: page }) => {
  await open(page, { 'notes.txt': 'hello' });
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('notes.txt');
  await expectEditorText(group, 'hello');

  await focusEditorEnd(page, group);
  await page.keyboard.type(' world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await save(page);
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, 'notes.txt')).toBe('hello world');
  await expect.poll(() => listBackups(page)).toEqual([]);

  await page.reload();
  await expect(selectedTab(groups(page).first())).toHaveText('notes.txt');
  await expectEditorText(groups(page).first(), 'hello world');
});

test('keeps an unsaved draft across a reload, dirty, and drops it once saved', async ({ appPage: page }) => {
  await open(page, { 'draft.md': 'saved' });
  const group = groups(page).first();
  await expectEditorText(group, 'saved');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' and unsaved');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  const restored = groups(page).first();
  await expect(selectedTab(restored)).toHaveText('draft.md');
  await expect(selectedTab(restored)).toHaveAccessibleDescription('Modified');
  await expectEditorText(restored, 'saved and unsaved');
  expect(await readWorkspaceText(page, 'draft.md')).toBe('saved');

  await focusEditorEnd(page, restored);
  await save(page);
  await expect(selectedTab(restored)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, 'draft.md')).toBe('saved and unsaved');
  await expect.poll(() => listBackups(page)).toEqual([]);
});

test('an inactive tab restored with a draft shows it is modified before it is shown', async ({ appPage: page }) => {
  await open(page, { 'shown.txt': 'shown', 'behind.txt': 'behind' });
  const group = groups(page).first();
  await group.getByRole('tab', { name: 'behind.txt' }).click();
  await expectEditorText(group, 'behind');
  await focusEditorEnd(page, group);
  await page.keyboard.type('!');
  await group.getByRole('tab', { name: 'shown.txt' }).click();
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  const restored = groups(page).first();
  await expect(selectedTab(restored)).toHaveText('shown.txt');
  await expect(restored.getByRole('tab', { name: 'behind.txt' })).toHaveAccessibleDescription('Modified');
});

test('asks before leaving the page while a draft is not backed up yet', async ({ appPage: page }) => {
  await open(page, { 'quick.txt': 'x' });
  const group = groups(page).first();
  await expectEditorText(group, 'x');
  await focusEditorEnd(page, group);
  await page.keyboard.type('y');
  const dialog = page.waitForEvent('dialog', { timeout: 15_000 });
  const reload = page.reload();
  expect((await dialog).type()).toBe('beforeunload');
  await (await dialog).dismiss();
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  // Once the draft is written there is nothing to ask.
  await expect.poll(() => listBackups(page)).toHaveLength(1);
  await page.reload();
  await reload.catch(() => {});
  await expectEditorText(groups(page).first(), 'xy');
});

test('undo back to the saved text clears the modified mark', async ({ appPage: page }) => {
  await open(page, { 'undo.txt': 'base' });
  const group = groups(page).first();
  await expectEditorText(group, 'base');
  await focusEditorEnd(page, group);
  await page.keyboard.type('!');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('asks before overwriting a file another tab saved first', async ({ appPage: page }) => {
  await open(page, { 'shared.txt': 'base' });
  const group = groups(page).first();
  await expectEditorText(group, 'base');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' mine');
  await writeWorkspaceFile(page, 'shared.txt', 'theirs');
  await page.waitForTimeout(200);
  await expectEditorText(group, 'base mine');

  await focusEditorEnd(page, group);
  await save(page);
  const question = page.getByText(/Failed to save 'shared\.txt': The content of the file is newer/);
  await expect(question).toBeVisible();
  await page.getByRole('option', { name: /^Cancel/ }).click();
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  expect(await readWorkspaceText(page, 'shared.txt')).toBe('theirs');

  await focusEditorEnd(page, group);
  await save(page);
  await page.getByRole('option', { name: /^Overwrite/ }).click();
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, 'shared.txt')).toBe('base mine');
});

test('“Revert” in the save question loads the newer file', async ({ appPage: page }) => {
  await open(page, { 'shared.txt': 'base' });
  const group = groups(page).first();
  await expectEditorText(group, 'base');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' mine');
  await writeWorkspaceFile(page, 'shared.txt', 'theirs');
  await save(page);
  await page.getByRole('option', { name: /^Revert/ }).click();
  await expectEditorText(group, 'theirs');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('shows an outside change in a clean editor, keeps a dirty editor’s text, and keeps a deleted file’s text', async ({ appPage: page }) => {
  await open(page, { 'watched.txt': 'one' });
  const group = groups(page).first();
  await expectEditorText(group, 'one');
  await writeWorkspaceFile(page, 'watched.txt', 'two');
  await expectEditorText(group, 'two');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');

  await focusEditorEnd(page, group);
  await page.keyboard.type(' typed');
  await writeWorkspaceFile(page, 'watched.txt', 'three');
  await page.waitForTimeout(300);
  await expectEditorText(group, 'two typed');

  await deleteWorkspaceFile(page, 'watched.txt');
  await expect(group.locator('.tab', { has: page.getByRole('tab', { name: 'watched.txt' }) }))
    .toHaveAttribute('title', 'workspace/watched.txt (deleted)');
  await expectEditorText(group, 'two typed');
  await focusEditorEnd(page, group);
  await save(page);
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, 'watched.txt')).toBe('two typed');
});

test('keeps the UTF-8 BOM and the line breaks of a file', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'bom.txt', { bytes: [0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a\r\nb')] });
  await openFilesByRestore(page, ['bom.txt']);
  const group = groups(page).first();
  await expectEditorText(group, 'a\nb');
  await focusEditorEnd(page, group);
  await page.keyboard.type('c');
  await page.keyboard.press('Enter');
  await page.keyboard.type('d');
  await save(page);
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceBytes(page, 'bom.txt')).toEqual([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a\r\nbc\r\nd')]);
});

test('says why a binary file, a file over 20 MiB and a missing file are not opened as text', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'image.png', { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00] });
  await writeWorkspaceFile(page, 'huge.log', { repeat: 'x', count: 20 * 1024 * 1024 + 1 });
  await openFilesByRestore(page, ['image.png', 'huge.log', 'missing.txt']);
  const group = groups(page).first();
  const reason = group.getByRole('alert');
  await expect(reason).toHaveText(/binary or uses an unsupported text encoding/);
  await expect(group.locator('.monaco-editor')).toBeHidden();

  await group.getByRole('tab', { name: 'huge.log' }).click();
  await expect(reason).toHaveText(/larger than 20 MB/);
  await expect(group.locator('.monaco-editor')).toBeHidden();
  await group.getByRole('tab', { name: 'missing.txt' }).click();
  await expect(reason).toHaveText(/file was not found/);
});

test('shows one file in two groups through one text, and tells same-named files apart by folder', async ({ appPage: page }) => {
  await open(page, { 'docs/index.md': 'docs', 'notes/index.md': 'notes' }, ['docs', 'notes']);
  const left = groups(page).first();
  await expect(left.getByRole('tab', { name: 'index.md' })).toHaveCount(2);
  await expect(selectedTab(left)).toHaveAccessibleDescription('docs');
  await expect(left.getByRole('tab', { name: 'index.md' }).last()).toHaveAccessibleDescription('notes');

  await left.getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const right = groups(page).last();
  await expectEditorText(right, 'docs');
  await focusEditorEnd(page, right);
  await page.keyboard.type(' shared');
  await expectEditorText(left, 'docs shared');
  await expect(selectedTab(left)).toHaveAccessibleDescription('docs, Modified');

  await right.getByRole('button', { name: 'Close index.md' }).click();
  await expect(groups(page)).toHaveCount(1);
  await expectEditorText(left, 'docs shared');
});

test('shows a read-only file with a lock and does not take typing', async ({ appPage: page, baseURL }) => {
  await openFilesByRestore(page, [new URL('/index.html', baseURL).href]);
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('index.html');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Read-only');
  await expect(group.locator('.monaco-editor')).toBeVisible();
  const before = await group.locator('.monaco-editor .view-lines').first().innerText();
  await focusEditorEnd(page, group);
  await page.keyboard.type('typed');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Read-only');
  expect(await group.locator('.monaco-editor .view-lines').first().innerText()).toBe(before);
});

test('a dirty file asks before it closes: Cancel keeps the tab, the text and the draft; a clean file closes at once', async ({ appPage: page }) => {
  await open(page, { 'dirty.md': 'saved', 'clean.md': 'clean' });
  const group = groups(page).first();
  await expectEditorText(group, 'saved');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' and more');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await group.getByRole('button', { name: 'Close dirty.md' }).click();
  await expect(quickPick(page, 'Do you want to save the changes you made to dirty.md?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(quickPick(page, /Do you want to save/)).toHaveCount(0);
  await expect(selectedTab(group)).toHaveText('dirty.md');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expectEditorText(group, 'saved and more');
  expect(await listBackups(page)).toHaveLength(1);

  await group.getByRole('button', { name: 'Close dirty.md' }).click();
  await answerCloseQuestion(page, 'dirty.md', 'Cancel');
  await expect(selectedTab(group)).toHaveText('dirty.md');
  expect(await listBackups(page)).toHaveLength(1);

  // The clean one closes without a question.
  await group.getByRole('button', { name: 'Close clean.md' }).click();
  await expect(group.getByRole('tab', { name: 'clean.md' })).toHaveCount(0);
  await expect(quickPick(page, /Do you want to save/)).toHaveCount(0);

  await group.getByRole('button', { name: 'Close dirty.md' }).click();
  await answerCloseQuestion(page, 'dirty.md', "Don't Save");
  await expect(group.getByRole('tab', { name: 'dirty.md' })).toHaveCount(0);
  expect(await readWorkspaceText(page, 'dirty.md')).toBe('saved');
  await expect.poll(() => listBackups(page)).toEqual([]);
});

test('closing three dirty editors asks one at a time, and a Cancel keeps the rest open', async ({ appPage: page }) => {
  await open(page, { 'one.md': '1', 'two.md': '2', 'three.md': '3' });
  const group = groups(page).first();
  for (const name of ['one.md', 'two.md', 'three.md']) {
    await group.getByRole('tab', { name }).click();
    await expectEditorText(group, name[0] === 'o' ? '1' : name[0] === 't' && name[1] === 'w' ? '2' : '3');
    await focusEditorEnd(page, group);
    await page.keyboard.type('!');
    await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  }
  await group.getByRole('tab', { name: 'one.md' }).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Close All', exact: true }).click();
  await answerCloseQuestion(page, 'one.md', "Don't Save");
  await answerCloseQuestion(page, 'two.md', 'Cancel');
  await expect(quickPick(page, /Do you want to save/)).toHaveCount(0);
  await expect(group.getByRole('tab')).toHaveText(['one.md', 'two.md', 'three.md']);
  await expect(group.getByRole('tab', { name: 'two.md' })).toHaveAccessibleDescription('Modified');
  await expect(group.getByRole('tab', { name: 'three.md' })).toHaveAccessibleDescription('Modified');
  await group.getByRole('tab', { name: 'three.md' }).click();
  await expectEditorText(group, '3!');
});

test('Save As picks a path with the keyboard alone, refuses one outside the workspace, and asks before replacing a file', async ({ appPage: page }) => {
  await open(page, { 'notes.txt': 'notes', 'other.txt': 'other' });
  const group = groups(page).first();
  await expectEditorText(group, 'notes');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' v2');

  // Onto an existing file: asked first; Cancel goes back to the list.
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const list = quickPick(page, 'Save As');
  await expect(list).toBeFocused();
  await page.keyboard.type('other');
  await page.keyboard.press('Enter');
  const replace = quickPick(page, 'Save As: other.txt already exists. Do you want to replace it?');
  await expect(replace).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toBeFocused();
  expect(await readWorkspaceText(page, 'other.txt')).toBe('other');

  // A typed path is checked before it is taken.
  await page.keyboard.type('Type a');
  await page.keyboard.press('Enter');
  const path = quickInputBox(page, 'Save As');
  await expect(path).toBeFocused();
  await page.keyboard.type('../../outside.txt');
  await expect(page.getByRole('status').filter({ hasText: 'The path must be inside the workspace folder.' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(path).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('bad\\name.txt');
  await expect(page.getByRole('status').filter({ hasText: 'A path cannot hold' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('copy.txt');
  await expect(path).not.toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Enter');

  await expect(group.getByRole('tab')).toHaveText(['copy.txt', 'other.txt']);
  await expect(selectedTab(group)).toHaveText('copy.txt');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, 'copy.txt')).toBe('notes v2');
  // The original keeps what it had on disk.
  expect(await readWorkspaceText(page, 'notes.txt')).toBe('notes');

  // Replace, this time.
  await focusEditorEnd(page, group);
  await page.keyboard.type(' v3');
  await page.keyboard.press('ControlOrMeta+Shift+S');
  await expect(list).toBeFocused();
  await page.keyboard.type('other');
  await page.keyboard.press('Enter');
  await expect(replace).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(selectedTab(group)).toHaveText('other.txt');
  await expect(group.getByRole('tab')).toHaveText(['other.txt']);
  await expect.poll(() => readWorkspaceText(page, 'other.txt')).toBe('notes v2 v3');
});

test('saving untitled text puts the file in its tab’s place with the same scroll, and no untitled tab is left', async ({ appPage: page }) => {
  await open(page, { 'a.txt': 'a', 'b.txt': 'b' });
  const group = groups(page).first();
  await expectEditorText(group, 'a');
  await fileMenu(page, 'New Text File');
  await expect(group.getByRole('tab')).toHaveText(['a.txt', 'Untitled-1', 'b.txt']);
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  const lines = Array.from({ length: 150 }, (_, index) => 'line ' + (index + 1));
  await page.keyboard.insertText(lines.join('\n'));
  await expect.poll(async () => (await renderedText(group)).includes('line 150')).toBe(true);
  const visible = await renderedText(group);
  expect(visible.split('\n')).not.toContain('line 1');

  await page.keyboard.press('ControlOrMeta+s');
  await expect(quickPick(page, 'Save As')).toBeFocused();
  await chooseOption(page, 'Save');
  await expect(group.getByRole('tab')).toHaveText(['a.txt', 'Untitled-1.txt', 'b.txt']);
  await expect(selectedTab(group)).toHaveText('Untitled-1.txt');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await expect(group.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveCount(0);
  expect(await readWorkspaceText(page, 'Untitled-1.txt')).toBe(lines.join('\n'));
  await expect.poll(() => renderedText(group)).toBe(visible);
});

test('File > New File... asks for a path in the workspace and opens the empty file', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'docs/keep.md', 'keep', ['docs']);
  await fileMenu(page, 'New File...');
  await expect(quickPick(page, 'Create File')).toBeFocused();
  await chooseOption(page, 'docs/');
  await chooseOption(page, 'Type a Name or Path...');
  await expect(quickInputBox(page, 'Create File')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('fresh.md');
  await page.keyboard.press('Enter');
  const group = groups(page).first();
  await expect(selectedTab(group)).toHaveText('fresh.md');
  await expect(group.getByRole('tab', { name: 'fresh.md' })).toHaveCount(1);
  await expect.poll(() => readWorkspaceText(page, 'docs/fresh.md')).toBe('');
});

test.describe('the dialog API', () => {
  const manifest = JSON.parse(readFileSync(new URL('../fixtures/extensions/files/package.json', import.meta.url), 'utf8'));

  test.beforeEach(async ({ page }) => {
    const fixture: InstalledExtensionFixture = { location: extensionFixtureLocation('files'), manifest };
    await seedInstalledExtensions(page, [fixture]);
  });

  async function run(page: Page, title: string): Promise<void> {
    await page.keyboard.press('F1');
    const palette = page.getByRole('combobox', { name: 'Type a command' });
    await expect(palette).toBeFocused();
    await palette.fill(title);
    await page.getByRole('option', { name: title, exact: true }).click();
  }

  test('showOpenDialog gives a list of workspace URIs and shows only the filtered files', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'notes.md', 'n');
    await writeWorkspaceFile(page, 'skip.txt', 's');
    await run(page, 'Files Fixture: Open Many');
    await expect(quickPick(page, 'Fixture Open')).toBeFocused();
    const options = page.getByRole('listbox', { name: 'Results' }).getByRole('option');
    await expect(options).toHaveText([/^Type a Path\.\.\./, 'notes.md']);
    await chooseOption(page, 'notes.md');
    await expect(page.getByText('Open dialog gave list vscode-vfs:/workspace/notes.md', { exact: true })).toBeVisible();
  });

  test('showSaveDialog starts in the workspace whatever it is given and never answers with a path outside', async ({ appPage: page }) => {
    await waitForStorage(page);
    await run(page, 'Files Fixture: Save Starting Outside');
    await expect(quickPick(page, 'Fixture Save')).toBeFocused();
    await expect(page.getByRole('option', { name: /^Keep Here/ })).toHaveText('Keep Here /workspace/passwd');
    await chooseOption(page, 'Type a Name or Path...');
    await expect(quickInputBox(page, 'Fixture Save')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('/etc/passwd');
    await expect(page.getByRole('status').filter({ hasText: 'The path must be inside the workspace folder.' })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('../workspace/./saved.md');
    await expect(quickInputBox(page, 'Fixture Save')).not.toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Save dialog gave uri vscode-vfs:/workspace/saved.md', { exact: true })).toBeVisible();

    await run(page, 'Files Fixture: Save Starting Outside');
    await expect(quickPick(page, 'Fixture Save')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Save dialog gave nothing', { exact: true })).toBeVisible();
  });
});
