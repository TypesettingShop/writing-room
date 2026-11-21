import type { Page } from '@playwright/test';
import { expect as baseExpect, test } from './fixtures.js';
import { startWithMarkdownSource } from './configuration.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { treeItem } from './explorer.helpers.js';
import {
  answerCloseQuestion, chooseOption, expectEditorText, focusEditorEnd, groups, listBackups, readWorkspaceText, selectedTab,
  waitForStorage, writeWorkspaceFile,
} from './files.helpers.js';
import manifest from '../fixtures/extensions/custom-editor/package.json' with { type: 'json' };

test.beforeEach(async ({ page }) => {
  await startWithMarkdownSource(page);
});

const editorStateKey = 'writing-room:storage:1:memento/workbench.parts.editor';

// The first custom text editor of a page waits for Monaco, as the first text editor does: its text
// model is a Monaco model, and Monaco loads with the first one (in the dev server, as hundreds of
// modules). Until then the pane says "Restoring Webview…". Measured: 1-4 seconds on a loaded machine
// before the provider is even asked, on top of waking the extension and loading the Webview's two
// frames, so expect's default 5 seconds ran out (wr-epmc, wr-9i4l). The text editor's helpers give
// the same wait 20 seconds (`expectEditorText`); so does every wait here, and each test more room.
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

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
  readonly documentsOpened: string[];
  readonly documentsDisposed: string[];
  readonly saves: number;
  readonly reverts: number;
  readonly undos: number;
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

test('a WorkspaceEdit from the preview is one undoable change in the WYSIWYG pane', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.md', '# Draft');
  await treeItem(page, 'a.md').click();
  const left = groups(page).first();
  await left.getByRole('button', { name: 'Switch to WYSIWYG' }).click();
  const editor = left.getByRole('textbox', { name: 'Markdown editor' });
  await expect(editor.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await command(page, 'Fixture: Open Preview Beside');
  await expect(content(page).locator('#text')).toHaveText('# Draft');

  await content(page).getByRole('button', { name: 'Append' }).click();
  await expect(editor.getByRole('heading', { name: 'Draft!', exact: true })).toBeVisible();
  await expect(selectedTab(left)).toHaveAccessibleDescription('Modified');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.getByRole('heading', { name: 'Draft', exact: true })).toBeVisible();
  await expect(content(page).locator('#text')).toHaveText('# Draft');
  await expect(selectedTab(left)).toHaveAccessibleDescription('');
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

test('a custom editor in front at a reload comes back as the custom editor, twice, without falling back to text', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.note', 'kept');
  await treeItem(page, 'a.note').click();
  const group = groups(page).first();
  await expect(content(page).locator('#text')).toHaveText('kept');

  // The page going stops the extension host before the state is written for the last time: the editor in
  // front must not be taken for one whose provider is missing (wr-wnvo).
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expect(selectedTab(group)).toHaveText('a.note');
    await expect(content(page).locator('#text')).toHaveText('kept');
    await expect(group.locator('.monaco-editor')).toHaveCount(0);
    await expect(page.getByText(/is unavailable\. Its files open in the text editor/)).toHaveCount(0);
    expect(await page.evaluate(key => localStorage.getItem(key), editorStateKey)).toContain('fixture.noteView');
  }
});

test('keeps the draft of a file edited only in a custom text editor across a reload, its tab modified before it shows', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'a.note', 'kept');
  await writeWorkspaceFile(page, 'b.txt', 'b');
  await treeItem(page, 'a.note').click();
  await expect(content(page).locator('#text')).toHaveText('kept');
  await content(page).getByRole('button', { name: 'Append' }).click();
  await expect(content(page).locator('#text')).toHaveText('kept!');
  await treeItem(page, 'b.txt').click();
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  const group = groups(page).first();
  await expect(group.getByRole('tab')).toHaveText(['Welcome', 'a.note', 'b.txt']);
  await expect(selectedTab(group)).toHaveText('b.txt');
  // The draft survives startup's cleanup, and the tab behind says so before it is shown.
  await expect(group.getByRole('tab', { name: 'a.note' })).toHaveAccessibleDescription('Modified');
  expect(await listBackups(page)).toHaveLength(1);
  await group.getByRole('tab', { name: 'a.note' }).click();
  await expect(content(page).locator('#text')).toHaveText('kept!');
  expect(await readWorkspaceText(page, 'a.note')).toBe('kept');

  await command(page, 'File: Save');
  await expect.poll(() => readWorkspaceText(page, 'a.note')).toBe('kept!');
  await expect(selectedTab(group)).not.toHaveAccessibleDescription('Modified');
  await expect.poll(() => listBackups(page)).toEqual([]);
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

test('opens a file the text editor refuses in a read-only custom editor, one document for its editors', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'b.bin', { bytes: [0, 1, 2, 255] });
  await treeItem(page, 'b.bin').click();
  const [left, right] = [groups(page).first(), groups(page).nth(1)];
  await expect(content(page).locator('#binary')).toHaveText('Binary b.bin');

  await command(page, 'View: Reopen Editor With...');
  await chooseOption(page, 'Text Editor');
  await expect(left.getByRole('alert')).toContainText('binary');
  await command(page, 'View: Reopen Editor With...');
  await chooseOption(page, 'Binary View');
  await expect(content(page).locator('#binary')).toHaveText('Binary b.bin');

  // The provider allows more editors per document: a second one shares the document.
  await left.getByRole('tab', { name: 'Welcome' }).click();
  await command(page, 'View: Split Editor Right');
  await expect(groups(page)).toHaveCount(2);
  await treeItem(page, 'b.bin').click();
  await expect(selectedTab(right)).toHaveText('b.bin');
  await expect(content(page).locator('#binary')).toHaveText('Binary b.bin');
  expect((await probe(page)).documentsOpened).toEqual(['b.bin', 'b.bin']);

  await right.getByRole('button', { name: 'Close b.bin' }).click();
  expect((await probe(page)).documentsDisposed).toEqual(['b.bin']);
  await left.getByRole('button', { name: 'Close b.bin' }).click();
  await expect.poll(async () => (await probe(page)).documentsDisposed).toEqual(['b.bin', 'b.bin']);
});

test('an editable custom document undoes in order, saves through its provider and asks before the page goes', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'c.count', 'x');
  await treeItem(page, 'c.count').click();
  const group = groups(page).first();
  const counter = content(page);
  await expect(counter.locator('#text')).toHaveText('0');
  const tab = selectedTab(group);
  await expect(tab).not.toHaveAccessibleDescription('Modified');

  await counter.getByRole('button', { name: 'Increment' }).click();
  await counter.getByRole('button', { name: 'Increment' }).click();
  await expect(counter.locator('#text')).toHaveText('2');
  await expect(tab).toHaveAccessibleDescription('Modified');
  // A key pressed in the Webview reaches the workbench's Undo.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(counter.locator('#text')).toHaveText('1');
  // In an input of the Webview the key is the input's own: the document is not undone with it.
  const { undos } = await probe(page);
  const field = counter.getByRole('textbox', { name: 'Field' });
  await field.pressSequentially('ab');
  await expect(field).toHaveValue('ab');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).not.toHaveValue('ab');
  // So is the Z key of a layout where it types another letter: the workbench matches the physical key.
  const cdp = await page.context().newCDPSession(page);
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers, key: 'я', code: 'KeyZ', windowsVirtualKeyCode: 90 });
  }
  await cdp.detach();
  // The probe runs after any undo the key would have sent to the extension host.
  expect((await probe(page)).undos).toBe(undos);
  // Three toasts show at once: the probes make room for the ones below.
  const probes = page.locator('section.extension-toast').filter({ hasText: /^Probe \{/ });
  for (let left = await probes.count(); left > 0; left--) {
    await probes.first().getByRole('button', { name: 'Dismiss message' }).click();
    await expect(probes).toHaveCount(left - 1);
  }
  await expect(counter.locator('#text')).toHaveText('1');
  await command(page, 'Edit: Undo');
  await expect(counter.locator('#text')).toHaveText('0');
  await expect(tab).not.toHaveAccessibleDescription('Modified');
  await command(page, 'Edit: Redo');
  await expect(counter.locator('#text')).toHaveText('1');
  await expect(tab).toHaveAccessibleDescription('Modified');

  await counter.getByRole('button', { name: 'Fail Next Save' }).click();
  await command(page, 'File: Save');
  await expect(page.getByText("Failed to save 'c.count': Fixture save failure")).toBeVisible();
  await expect(tab).toHaveAccessibleDescription('Modified');
  await command(page, 'File: Save');
  await expect(tab).not.toHaveAccessibleDescription('Modified');
  expect((await probe(page)).saves).toBe(1);

  // Back at the save point by undo: clean again.
  await counter.getByRole('button', { name: 'Increment' }).click();
  await expect(tab).toHaveAccessibleDescription('Modified');
  await command(page, 'Edit: Undo');
  await expect(counter.locator('#text')).toHaveText('1');
  await expect(tab).not.toHaveAccessibleDescription('Modified');

  await counter.getByRole('button', { name: 'Increment' }).click();
  await expect(tab).toHaveAccessibleDescription('Modified');
  const dialog = page.waitForEvent('dialog', { timeout: 15_000 });
  // The reload stays pending once the page stays.
  void page.reload().catch(() => {});
  expect((await dialog).type()).toBe('beforeunload');
  await (await dialog).dismiss();
  await expect(tab).toHaveAccessibleDescription('Modified');

  // Reopen With asks before the document, and its unsaved changes, would go with the editor.
  await command(page, 'View: Reopen Editor With...');
  await chooseOption(page, 'Text Editor');
  await answerCloseQuestion(page, 'c.count', 'Cancel');
  await expect(counter.locator('#text')).toHaveText('2');
  await expect(tab).toHaveAccessibleDescription('Modified');

  await page.getByRole('button', { name: 'Close c.count' }).click();
  await answerCloseQuestion(page, 'c.count', "Don't Save");
  await expect(page.getByRole('tab', { name: 'c.count' })).toHaveCount(0);
  const seen = await probe(page);
  expect(seen).toMatchObject({ reverts: 1, documentsOpened: ['c.count'], documentsDisposed: ['c.count'] });
});
