import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import {
  contextMenuByKeyboard, dragFiles, DROP_TARGET_ATTRIBUTE, explorerInput, explorerTree, fileTabs, focusRow, part, rowNames,
  treeItem,
} from './explorer.helpers.js';
import {
  answerCloseQuestion, chooseOption, expectEditorText, focusEditorEnd, groups, quickPick, readWorkspaceBytes, readWorkspaceText,
  selectedTab, waitForStorage, writeWorkspaceFile,
} from './files.helpers.js';

/** Opens a second tab of the same storage, its Explorer drawn. */
async function otherTab(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  expect((await other.goto('/'))?.ok()).toBe(true);
  await expect(explorerTree(other)).toBeVisible();
  return other;
}

/** The text area of the first group's editor. */
const editorText = (page: Page) => groups(page).first().getByRole('textbox', { name: 'Editor content' });

/**
 * Focuses the Explorer from the keyboard (View: Show Explorer). A file just created opens its editor,
 * which may take the focus after the key: the key is pressed again then.
 */
async function focusExplorer(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+Shift+E');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="tree"]')?.getAttribute('aria-label')),
      { timeout: 1_000 }).toBe('Files Explorer');
  }).toPass();
}

test('the Explorer shows the workspace folder as a tree, folders first and in natural order', async ({ appPage: page }) => {
  const sidebar = part(page, 'sidebar');
  await expect(sidebar.getByText('No folder opened')).toHaveCount(0);
  await expect(sidebar.getByRole('heading', { name: 'workspace' })).toBeVisible();
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'file10.md', 'ten');
  await writeWorkspaceFile(page, 'file2.md', 'two');
  await writeWorkspaceFile(page, 'Beta.md', 'b');
  await writeWorkspaceFile(page, 'zeta/inner.md', 'z', ['zeta']);
  await writeWorkspaceFile(page, 'alpha/inner.md', 'a', ['alpha']);
  await expect.poll(() => rowNames(page)).toEqual(['alpha', 'zeta', 'Beta.md', 'file2.md', 'file10.md']);
  await expect(treeItem(page, 'alpha')).toHaveAttribute('aria-expanded', 'false');
  await expect(treeItem(page, 'alpha')).toHaveAttribute('aria-level', '1');
  await expect(treeItem(page, 'Beta.md')).not.toHaveAttribute('aria-expanded');

  await treeItem(page, 'alpha').click();
  await expect(treeItem(page, 'alpha')).toHaveAttribute('aria-expanded', 'true');
  await expect(treeItem(page, 'alpha')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'inner.md')).toHaveAttribute('aria-level', '2');

  // A click opens a file and leaves the focus in the tree.
  await treeItem(page, 'file2.md').click();
  await expect(selectedTab(groups(page).first())).toHaveText('file2.md');
  await expect(treeItem(page, 'file2.md')).toBeFocused();
  await expect(treeItem(page, 'file2.md')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'alpha')).toHaveAttribute('aria-selected', 'false');
});

test('keyboard alone creates, renames and deletes, and the file service and another tab follow', async ({ appPage: page }) => {
  await waitForStorage(page);
  const other = await otherTab(page);

  // New file from the tree's context menu.
  await focusExplorer(page);
  await contextMenuByKeyboard(page, 'New File...');
  await expect(explorerInput(page)).toBeFocused();
  await page.keyboard.type('draft.md');
  await page.keyboard.press('Enter');
  await expect(selectedTab(groups(page).first())).toHaveText('draft.md');
  // The new file's editor takes the focus.
  await expect(editorText(page)).toBeFocused();
  await expect.poll(() => readWorkspaceText(page, 'draft.md')).toBe('');
  await expect(treeItem(page, 'draft.md')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(other, 'draft.md')).toBeVisible();

  // New folder: the row of a file gives its folder, the workspace folder.
  await focusExplorer(page);
  await expect(treeItem(page, 'draft.md')).toBeFocused();
  await contextMenuByKeyboard(page, 'New Folder...');
  await expect(explorerInput(page)).toBeFocused();
  await page.keyboard.type('notes');
  await page.keyboard.press('Enter');
  await expect(treeItem(page, 'notes')).toBeFocused();
  await expect(treeItem(page, 'notes')).toHaveAttribute('aria-expanded', 'false');
  await expect(treeItem(other, 'notes')).toBeVisible();
  await expect.poll(() => rowNames(page)).toEqual(['notes', 'draft.md']);

  // A new file inside the folder, then arrows move through the tree.
  await contextMenuByKeyboard(page, 'New File...');
  await expect(explorerInput(page)).toBeFocused();
  await expect(treeItem(page, 'notes')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.type('inside.md');
  await page.keyboard.press('Enter');
  await expect(selectedTab(groups(page).first())).toHaveText('inside.md');
  await expect(editorText(page)).toBeFocused();
  await expect.poll(() => readWorkspaceText(page, 'notes/inside.md')).toBe('');
  await focusExplorer(page);
  await expect(treeItem(page, 'inside.md')).toBeFocused();
  await expect(treeItem(page, 'inside.md')).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('Home');
  await expect(treeItem(page, 'notes')).toBeFocused();
  await page.keyboard.press('End');
  await expect(treeItem(page, 'draft.md')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(treeItem(page, 'inside.md')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(treeItem(page, 'notes')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(treeItem(page, 'notes')).toHaveAttribute('aria-expanded', 'false');
  await expect(treeItem(page, 'inside.md')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'notes')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(treeItem(page, 'inside.md')).toBeFocused();

  // F2 renames; the editor of the file follows to the new path in the same place.
  await page.keyboard.press('F2');
  await expect(explorerInput(page)).toBeFocused();
  await expect(explorerInput(page)).toHaveValue('inside.md');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('renamed.md');
  await page.keyboard.press('Enter');
  await expect(treeItem(page, 'renamed.md')).toBeFocused();
  await expect(treeItem(page, 'inside.md')).toHaveCount(0);
  await expect(selectedTab(groups(page).first())).toHaveText('renamed.md');
  await expect(fileTabs(groups(page).first())).toHaveText(['draft.md', 'renamed.md']);
  await expect.poll(() => readWorkspaceText(page, 'notes/renamed.md')).toBe('');
  await expect.poll(() => readWorkspaceText(page, 'notes/inside.md')).toBeUndefined();
  await treeItem(other, 'notes').click();
  await expect(treeItem(other, 'renamed.md')).toBeVisible();
  await expect(treeItem(other, 'inside.md')).toHaveCount(0);

  // Delete asks first; Escape keeps the file.
  await page.keyboard.press('Delete');
  await expect(quickPick(page, "Are you sure you want to permanently delete 'renamed.md'?")).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(treeItem(page, 'renamed.md')).toBeFocused();
  await expect.poll(() => readWorkspaceText(page, 'notes/renamed.md')).toBe('');
  await page.keyboard.press('Delete');
  await expect(quickPick(page, "Are you sure you want to permanently delete 'renamed.md'?")).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(treeItem(page, 'renamed.md')).toHaveCount(0);
  await expect.poll(() => readWorkspaceText(page, 'notes/renamed.md')).toBeUndefined();
  await expect(fileTabs(groups(page).first())).toHaveText(['draft.md']);
  await expect(treeItem(other, 'renamed.md')).toHaveCount(0);
  await other.close();
});

test('the inline input refuses names that cannot be, with its reason, and keeps what was typed', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'taken.md', 't');
  await expect(treeItem(page, 'taken.md')).toBeVisible();
  await focusExplorer(page);
  await contextMenuByKeyboard(page, 'New File...');
  const input = explorerInput(page);
  await expect(input).toBeFocused();
  const cases: [string, RegExp][] = [
    ['a/b.md', /not valid as a file or folder name/],
    ['a\\b.md', /not valid as a file or folder name/],
    ['.', /not valid as a file or folder name/],
    ['..', /not valid as a file or folder name/],
    ['bell\u0007.md', /not valid as a file or folder name/],
    ['taken.md', /A file or folder taken\.md already exists at this location/],
    ['x'.repeat(256), /longer than 255 characters/],
  ];
  for (const [name, reason] of cases) {
    await input.fill(name);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(reason);
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
  }
  await input.fill('');
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  expect(await rowNames(page)).toEqual(['', 'taken.md']);

  // Another tab's change redraws the tree; the input keeps its text and focus.
  await input.fill('kept.md');
  await expect(input).not.toHaveAttribute('aria-invalid');
  await writeWorkspaceFile(page, 'arrived.md', 'a');
  await expect.poll(() => rowNames(page)).toEqual(['', 'arrived.md', 'taken.md']);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('kept.md');
  await page.keyboard.type('x');
  await expect(input).toHaveValue('kept.mdx');

  // A name another tab takes while it is typed is refused too.
  await input.fill('late.md');
  await writeWorkspaceFile(page, 'late.md', 'l');
  await expect.poll(() => rowNames(page)).toEqual(['', 'arrived.md', 'late.md', 'taken.md']);
  await page.keyboard.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect.poll(() => rowNames(page)).toEqual(['arrived.md', 'late.md', 'taken.md']);

  // Renaming to a taken name is refused; to its own name it is nothing.
  await focusRow(page, 'taken.md');
  await page.keyboard.press('F2');
  await expect(input).toBeFocused();
  await input.fill('late.md');
  await expect(input).toHaveAccessibleDescription(/already exists/);
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await input.fill('taken.md');
  await page.keyboard.press('Enter');
  await expect(treeItem(page, 'taken.md')).toBeFocused();
  await expect.poll(() => readWorkspaceText(page, 'late.md')).toBe('l');
  await expect.poll(() => readWorkspaceText(page, 'taken.md')).toBe('t');
});

test('deleting a folder with an unsaved file asks about it first; a cancel deletes nothing', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'box/keep.md', 'keep', ['box']);
  await writeWorkspaceFile(page, 'box/clean.md', 'clean');
  await treeItem(page, 'box').click();
  await treeItem(page, 'keep.md').click();
  await treeItem(page, 'clean.md').click();
  const group = groups(page).first();
  await expect(fileTabs(group)).toHaveText(['keep.md', 'clean.md']);
  await group.getByRole('tab', { name: 'keep.md' }).click();
  await expectEditorText(group, 'keep');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' edited');
  await expect(group.getByRole('tab', { name: /keep\.md/ })).toHaveAccessibleDescription(/Modified/);

  await focusRow(page, 'box');
  await page.keyboard.press('Delete');
  await expect(quickPick(page, "Are you sure you want to permanently delete 'box' and its contents?")).toBeFocused();
  await chooseOption(page, 'Delete');
  await answerCloseQuestion(page, 'keep.md', 'Cancel');
  await expect(treeItem(page, 'box')).toBeVisible();
  await expect.poll(() => readWorkspaceText(page, 'box/keep.md')).toBe('keep');
  await expect(group.getByRole('tab', { name: /keep\.md/ })).toHaveAccessibleDescription(/Modified/);
  await expectEditorText(group, 'keep edited');

  await focusRow(page, 'box');
  await page.keyboard.press('Delete');
  await expect(quickPick(page, "Are you sure you want to permanently delete 'box' and its contents?")).toBeFocused();
  await chooseOption(page, 'Delete');
  await answerCloseQuestion(page, 'keep.md', "Don't Save");
  await expect(treeItem(page, 'box')).toHaveCount(0);
  await expect(fileTabs(group)).toHaveCount(0);
  await expect.poll(() => readWorkspaceText(page, 'box/keep.md')).toBeUndefined();
  await expect.poll(() => readWorkspaceText(page, 'box/clean.md')).toBeUndefined();
});

test('renaming an unsaved file saves it first or keeps everything as it was', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'story.md', 'once');
  await treeItem(page, 'story.md').click();
  const group = groups(page).first();
  await expectEditorText(group, 'once');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' upon');

  await focusRow(page, 'story.md');
  await page.keyboard.press('F2');
  await explorerInput(page).fill('tale.md');
  await page.keyboard.press('Enter');
  await expect(quickPick(page, "'story.md' has unsaved changes. Save them before renaming 'story.md'?")).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(treeItem(page, 'story.md')).toBeFocused();
  await expect(group.getByRole('tab', { name: /story\.md/ })).toHaveAccessibleDescription(/Modified/);
  await expect.poll(() => readWorkspaceText(page, 'story.md')).toBe('once');

  await page.keyboard.press('F2');
  await explorerInput(page).fill('tale.md');
  await page.keyboard.press('Enter');
  await expect(quickPick(page, /has unsaved changes/)).toBeFocused();
  await chooseOption(page, 'Save and Rename');
  await expect(treeItem(page, 'tale.md')).toBeFocused();
  await expect.poll(() => readWorkspaceText(page, 'tale.md')).toBe('once upon');
  await expect.poll(() => readWorkspaceText(page, 'story.md')).toBeUndefined();
  await expect(fileTabs(group)).toHaveText(['tale.md']);
  await expectEditorText(group, 'once upon');
});

test('expanded folders stay expanded after a reload, and the tree follows the active editor', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'one/a.md', 'a', ['one']);
  await writeWorkspaceFile(page, 'one/two/b.md', 'b', ['one/two']);
  await writeWorkspaceFile(page, 'three/c.md', 'c', ['three']);
  await treeItem(page, 'one').click();
  await treeItem(page, 'two').click();
  await expect(treeItem(page, 'b.md')).toBeVisible();

  await page.reload();
  await expect(treeItem(page, 'b.md')).toBeVisible();
  await expect(treeItem(page, 'one')).toHaveAttribute('aria-expanded', 'true');
  await expect(treeItem(page, 'two')).toHaveAttribute('aria-expanded', 'true');
  await expect(treeItem(page, 'three')).toHaveAttribute('aria-expanded', 'false');

  // Opening files: the selection follows the active editor, expanding the folders above it.
  await treeItem(page, 'b.md').click();
  await treeItem(page, 'a.md').click();
  await treeItem(page, 'one').click();
  await expect(treeItem(page, 'one')).toHaveAttribute('aria-expanded', 'false');
  const group = groups(page).first();
  await group.getByRole('tab', { name: 'b.md' }).click();
  await expect(treeItem(page, 'b.md')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'one')).toHaveAttribute('aria-expanded', 'true');
  await group.getByRole('tab', { name: 'a.md' }).click();
  await expect(treeItem(page, 'a.md')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'b.md')).toHaveAttribute('aria-selected', 'false');

  // Collapse All forgets them, after a reload too; only the active file's folder opens again.
  await part(page, 'sidebar').getByRole('button', { name: 'Collapse Folders in Explorer' }).click();
  await expect(treeItem(page, 'a.md')).toHaveCount(0);
  await page.reload();
  await expect(treeItem(page, 'a.md')).toHaveAttribute('aria-selected', 'true');
  await expect(treeItem(page, 'two')).toHaveAttribute('aria-expanded', 'false');
  await expect(treeItem(page, 'b.md')).toHaveCount(0);
});

test.describe('with the files fixture extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../fixtures/extensions/files/package.json', import.meta.url), 'utf8'));

  test.beforeEach(async ({ page }) => {
    await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('files'), manifest }]);
  });

  test('explorer/context entries show as their when says and get the item Uri', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'docs/read.md', 'r', ['docs']);
    await writeWorkspaceFile(page, 'plain.txt', 'p');
    const menu = page.getByRole('menu');

    await treeItem(page, 'plain.txt').click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Rename...' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Fixture Markdown Action' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Fixture Folder Action' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await treeItem(page, 'docs').click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Fixture Folder Action' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Fixture Markdown Action' })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Fixture Folder Action' }).click();
    await expect(page.getByText('filesFixture.folderItem gave Uri vscode-vfs:/workspace/docs', { exact: true })).toBeVisible();

    await treeItem(page, 'docs').click();
    await treeItem(page, 'read.md').click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Fixture Folder Action' })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Fixture Markdown Action' }).click();
    await expect(page.getByText('filesFixture.markdownItem gave Uri vscode-vfs:/workspace/docs/read.md', { exact: true }))
      .toBeVisible();
  });

  test('revealInExplorer opens the Explorer and reveals a file inside collapsed folders', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'deep/inner/note.md', 'n', ['deep', 'deep/inner']);
    await expect(treeItem(page, 'deep')).toHaveAttribute('aria-expanded', 'false');
    // The Explorer is in the panel and the sidebar is hidden: revealing opens its container.
    await part(page, 'activitybar').getByRole('button', { name: 'Explorer' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to Panel' }).click();
    await expect(part(page, 'panel').getByRole('tab', { name: 'Explorer' })).toBeVisible();
    await part(page, 'panel').getByRole('tab', { name: 'Output' }).click();
    await expect(explorerTree(page)).toBeHidden();

    await page.keyboard.press('F1');
    await page.getByRole('combobox', { name: 'Type a command' }).fill('Files Fixture: Reveal Deep Note');
    await page.getByRole('option', { name: 'Files Fixture: Reveal Deep Note', exact: true }).click();
    const note = treeItem(page, 'note.md');
    await expect(note).toBeFocused();
    await expect(note).toHaveAttribute('aria-selected', 'true');
    await expect(note).toHaveAttribute('aria-level', '3');
    await expect(treeItem(page, 'deep')).toHaveAttribute('aria-expanded', 'true');
    await expect(treeItem(page, 'inner')).toHaveAttribute('aria-expanded', 'true');
    await expect(part(page, 'panel').getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a view the extension adds to the Explorer container shows below the file tree', async ({ appPage: page }) => {
    const sidebar = part(page, 'sidebar');
    await expect(sidebar.getByRole('region', { name: 'Files Fixture View' })).toBeVisible();
    await expect(sidebar.getByRole('heading')).toHaveText(['Explorer', 'workspace', 'Files Fixture View']);
    await expect(sidebar.getByRole('region', { name: 'workspace' }).getByRole('tree', { name: 'Files Explorer' })).toBeVisible();
  });
});

test.describe('upload and download', () => {
  const MiB = 1024 * 1024;
  const binary = [0, 255, 128, 10, 13, 0xc3, 0x28, 0, 1];
  const menu = (page: Page) => page.getByRole('menu');

  /** Runs Upload... from the context menu of `row` and gives the chooser `files`. */
  async function uploadFromContextMenu(page: Page, row: string, files: { name: string; buffer: Buffer }[]): Promise<void> {
    await treeItem(page, row).click({ button: 'right' });
    const chooser = page.waitForEvent('filechooser');
    await menu(page).getByRole('menuitem', { name: 'Upload...', exact: true }).click();
    await (await chooser).setFiles(files.map(file => ({ ...file, mimeType: 'application/octet-stream' })));
  }

  /** Runs Upload... from the More Actions menu of the Explorer view's title and gives the chooser `files`. */
  async function uploadFromTitle(page: Page, files: { name: string; buffer: Buffer }[]): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    await part(page, 'sidebar').getByRole('toolbar').getByRole('button', { name: 'More Actions' }).click();
    await menu(page).getByRole('menuitem', { name: 'Upload...', exact: true }).click();
    await (await chooser).setFiles(files.map(file => ({ ...file, mimeType: 'application/octet-stream' })));
  }

  test('Upload... writes the chosen files into the folder with their bytes, shows and opens them', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'docs/keep.md', 'k', ['docs']);
    await writeWorkspaceFile(page, 'top.md', 't');

    // Upload is offered on folders, Download on files.
    await treeItem(page, 'top.md').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Upload...', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await treeItem(page, 'docs').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Download', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await uploadFromContextMenu(page, 'docs', [
      { name: 'notes.md', buffer: Buffer.from('# Notes\nsecond line') },
      { name: 'raw.bin', buffer: Buffer.from(binary) },
    ]);
    await expect(treeItem(page, 'notes.md')).toHaveAttribute('aria-level', '2');
    await expect(treeItem(page, 'raw.bin')).toHaveAttribute('aria-level', '2');
    expect(await readWorkspaceBytes(page, 'docs/notes.md')).toEqual(Array.from(Buffer.from('# Notes\nsecond line')));
    expect(await readWorkspaceBytes(page, 'docs/raw.bin')).toEqual(binary);
    // The first file opens, with the text it was uploaded with.
    await expect(selectedTab(groups(page).first())).toHaveText('notes.md');
    await expectEditorText(groups(page).first(), '# Notes\nsecond line');
    await expect(treeItem(page, 'notes.md')).toHaveAttribute('aria-selected', 'true');
  });

  test('an upload over a file of the same name asks first; Escape keeps the file, Replace replaces it', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'same.md', 'old');
    await expect(treeItem(page, 'same.md')).toBeVisible();
    const question = "A file named 'same.md' already exists in 'workspace'. Do you want to replace it?";

    await uploadFromTitle(page, [{ name: 'same.md', buffer: Buffer.from('new') }, { name: 'other.md', buffer: Buffer.from('o') }]);
    await expect(quickPick(page, question)).toBeFocused();
    // Nothing is written while the question is open.
    expect(await readWorkspaceText(page, 'other.md')).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(quickPick(page, question)).toHaveCount(0);
    expect(await readWorkspaceText(page, 'same.md')).toBe('old');
    expect(await readWorkspaceText(page, 'other.md')).toBeUndefined();

    await uploadFromTitle(page, [{ name: 'same.md', buffer: Buffer.from('new') }]);
    await expect(quickPick(page, question)).toBeFocused();
    await chooseOption(page, 'Replace');
    await expect.poll(() => readWorkspaceText(page, 'same.md')).toBe('new');
    await expectEditorText(groups(page).first(), 'new');
  });

  test('files dropped on a folder go into it, on empty space into the workspace folder', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'inbox/old.md', 'o', ['inbox']);
    await writeWorkspaceFile(page, 'loose.md', 'l');
    await expect(treeItem(page, 'loose.md')).toBeVisible();

    const over = await dragFiles(treeItem(page, 'inbox'), ['dragenter', 'dragover'], [{ name: 'in.md', text: 'into inbox' }]);
    // Taken, so the browser does not open the file instead.
    expect(over.taken).toEqual([true, true]);
    await expect(treeItem(page, 'inbox')).toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    await expect(explorerTree(page)).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    const drop = await dragFiles(treeItem(page, 'inbox'), ['drop'], [{ name: 'in.md', text: 'into inbox' }, { name: 'raw.bin', bytes: binary }]);
    expect(drop.taken).toEqual([true]);
    await expect(treeItem(page, 'inbox')).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    await expect.poll(() => readWorkspaceText(page, 'inbox/in.md')).toBe('into inbox');
    expect(await readWorkspaceBytes(page, 'inbox/raw.bin')).toEqual(binary);
    await expect(treeItem(page, 'in.md')).toHaveAttribute('aria-level', '2');

    // A file row stands for its folder; the tree's empty space for the workspace folder, the whole tree marked.
    await dragFiles(treeItem(page, 'loose.md'), ['dragover'], [{ name: 'x.md' }]);
    await expect(explorerTree(page)).toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    await dragFiles(explorerTree(page), ['dragover', 'drop'], [{ name: 'top.md', text: 'top' }]);
    await expect(explorerTree(page)).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    await expect.poll(() => readWorkspaceText(page, 'top.md')).toBe('top');
    await expect(treeItem(page, 'top.md')).toHaveAttribute('aria-level', '1');
    await expect(page).toHaveURL(/\/$/);
  });

  test('a file over 50 MiB, or more than 200 MiB in all, writes none of the files', async ({ appPage: page }) => {
    await waitForStorage(page);
    await dragFiles(explorerTree(page), ['dragover', 'drop'], [{ name: 'small.md', text: 'small' }, { name: 'big.bin', size: 50 * MiB + 1 }]);
    await expect(page.getByRole('alert').filter({ hasText: "Unable to upload 'big.bin': it is larger than 50 MB. Nothing was uploaded." }))
      .toBeVisible();
    await dragFiles(explorerTree(page), ['dragover', 'drop'], [
      { name: 'first.md', text: 'first' },
      ...[1, 2, 3, 4].map(index => ({ name: `part${index}.bin`, size: 50 * MiB })),
    ]);
    await expect(page.getByRole('alert').filter({ hasText: /^Unable to upload: the files come to 200\.0 MB/ })).toBeVisible();
    for (const path of ['small.md', 'big.bin', 'first.md', 'part1.bin']) {
      expect(await readWorkspaceBytes(page, path)).toBeUndefined();
    }
    await expect(explorerTree(page).getByRole('treeitem')).toHaveCount(0);
  });

  test('a drag that ends without a drop leaves no drop mark', async ({ appPage: page }) => {
    await waitForStorage(page);
    await writeWorkspaceFile(page, 'inbox/old.md', 'o', ['inbox']);
    const inbox = treeItem(page, 'inbox');
    const dragOver = async () => {
      await dragFiles(inbox, ['dragenter', 'dragover'], [{ name: 'x.md', text: 'x' }]);
      await expect(inbox).toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    };
    const unmarked = async () => {
      await expect(inbox).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
      await expect(explorerTree(page)).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    };

    await dragOver();
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await unmarked();

    await dragOver();
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    await unmarked();

    await dragOver();
    await page.evaluate(() => window.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
    await unmarked();

    // Out of the view, onto the editor area, and out of the window.
    await dragOver();
    await dragFiles(inbox, ['dragleave'], [{ name: 'x.md' }], part(page, 'editor'));
    await unmarked();
    await dragOver();
    await dragFiles(inbox, ['dragleave'], [{ name: 'x.md' }]);
    await unmarked();

    // Moving between rows of the view keeps the mark, on the row now under the pointer.
    await writeWorkspaceFile(page, 'outbox/old.md', 'o', ['outbox']);
    await dragOver();
    await dragFiles(inbox, ['dragleave'], [{ name: 'x.md' }], treeItem(page, 'outbox'));
    await dragFiles(treeItem(page, 'outbox'), ['dragenter', 'dragover'], [{ name: 'x.md' }]);
    await expect(treeItem(page, 'outbox')).toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    await expect(inbox).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    expect(await readWorkspaceBytes(page, 'x.md')).toBeUndefined();
    expect(await readWorkspaceBytes(page, 'inbox/x.md')).toBeUndefined();
  });

  test('files dropped on the editor area still do nothing, and nothing is written', async ({ appPage: page }) => {
    await waitForStorage(page);
    const editorArea = part(page, 'editor');
    await dragFiles(editorArea, ['dragenter', 'dragover', 'drop'], [{ name: 'dropped.md', text: 'dropped' }]);
    await expect(page.locator('[data-editor-drop-position]')).toHaveCount(0);
    await expect(explorerTree(page)).not.toHaveAttribute(DROP_TARGET_ATTRIBUTE);
    expect(await readWorkspaceBytes(page, 'dropped.md')).toBeUndefined();
    await expect(fileTabs(groups(page).first())).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test('Download saves the stored bytes of the file and then lets its URL go', async ({ appPage: page }) => {
    await waitForStorage(page);
    const bytes = Array.from({ length: 256 }, (_, index) => index);
    await writeWorkspaceFile(page, 'data/all.bin', { bytes }, ['data']);
    await page.evaluate(() => {
      const revoke = URL.revokeObjectURL.bind(URL);
      (window as unknown as { revoked: string[] }).revoked = [];
      URL.revokeObjectURL = url => {
        (window as unknown as { revoked: string[] }).revoked.push(url);
        revoke(url);
      };
    });
    await treeItem(page, 'data').click();
    await focusRow(page, 'all.bin');

    const download = page.waitForEvent('download');
    await contextMenuByKeyboard(page, 'Download');
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('all.bin');
    expect(Array.from(readFileSync((await saved.path())!))).toEqual(bytes);
    expect(saved.url()).toMatch(/^blob:/);
    await expect.poll(() => page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)).toEqual([saved.url()]);
    await expect(page.locator('a[download]')).toHaveCount(0);
  });
});
