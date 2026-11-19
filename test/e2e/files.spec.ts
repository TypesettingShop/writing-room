import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  deleteWorkspaceFile, expectEditorText, focusEditorEnd, groups, listBackups, openFilesByRestore, readWorkspaceBytes,
  readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile,
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
