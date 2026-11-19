import { expect, test } from './fixtures.js';
import {
  activityButton, center, dragOver, dropFromOutside, eventLog, item, notesTree, notesView, openTreeFixture, runCommand,
  selectColorTheme, startDrag,
} from './tree-view.helpers.js';

test('draws codicons, images from the extension for the theme kind, resource labels and late tooltips', async ({ page }) => {
  await openTreeFixture(page);
  const inbox = item(page, 'Inbox');
  await expect(inbox.locator('.codicon-inbox')).toHaveCSS('color', /rgb/);
  expect(await inbox.locator('.codicon-inbox').evaluate(element => (element as HTMLElement).style.color)).toBe('var(--vscode-charts-blue)');
  await inbox.click();
  await expect(item(page, 'Draft')).toBeVisible();
  const image = item(page, 'Draft').locator('img');
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect(image).toHaveAttribute('data-icon', 'dark');
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(16);
  // The icon outside the extension's folder is not drawn.
  await expect(item(page, 'Archive').locator('img')).toHaveCount(0);

  const readme = notesTree(page).getByRole('treeitem', { name: 'Read me first' });
  await expect(readme).toContainText('readme.md');
  await expect(readme).toHaveAttribute('title', '');
  await readme.hover();
  await expect(readme).toHaveAttribute('title', 'Resolved readme');

  await selectColorTheme(page, 'Writing Room Light');
  await expect(item(page, 'Draft').locator('img')).toHaveAttribute('data-icon', 'light');
  await expect(item(page, 'Draft').locator('img')).toHaveAttribute('src', /^blob:/);
});

test('reveal expands the ancestors, selects and focuses; events carry the extension\'s objects', async ({ page }) => {
  await openTreeFixture(page);
  await runCommand(page, 'Tree Fixture: Reveal Deep');
  const deep = item(page, 'Deep');
  await expect(deep).toBeVisible();
  await expect(deep).toHaveAttribute('aria-selected', 'true');
  await expect(deep).toBeFocused();
  await expect(item(page, 'Inbox')).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'Ideas')).toHaveAttribute('aria-expanded', 'true');
  await expect(eventLog(page)).toContainText('Revealed: Deep');
  await expect(eventLog(page)).toContainText('Expanded: Inbox (same object)');
  await expect(eventLog(page)).toContainText("Empty reveal: Required registered TreeDataProvider to implement 'getParent' method to access 'reveal' method");

  await item(page, 'Archive').click();
  await expect(eventLog(page)).toContainText('Selected: Archive (same objects)');
  await notesTree(page).getByRole('treeitem', { name: 'Read me first' }).click({ modifiers: ['ControlOrMeta'] });
  await expect(eventLog(page)).toContainText('Selected: Archive, Readme (same objects)');
  await expect(notesTree(page).getByRole('treeitem', { selected: true })).toHaveCount(2);

  await activityButton(page, 'Explorer').click();
  await expect(eventLog(page)).toContainText('Visible: false');
  await activityButton(page, 'Tree Fixture').click();
  await expect(eventLog(page)).toContainText('Visible: true');

  await notesView(page).getByRole('button', { name: 'Collapse All' }).click();
  await expect(deep).toHaveCount(0);
  await expect(item(page, 'Inbox')).toHaveAttribute('aria-expanded', 'false');
});

test('the view shows the title, description, badge and message the extension sets', async ({ page }) => {
  await openTreeFixture(page);
  await runCommand(page, 'Tree Fixture: Decorate');
  const view = notesView(page, 'Notebook');
  await expect(view.getByRole('heading', { name: 'Notebook' })).toBeVisible();
  await expect(view.getByText('three notes', { exact: true })).toBeVisible();
  await expect(view.getByRole('status', { name: '3 unread notes' })).toHaveText('3');
  await expect(view.getByText('Drag notes to <b>file</b> them.', { exact: true })).toBeVisible();
  await expect(view.locator('b')).toHaveCount(0);
});

test('the welcome text of an empty tree runs only the extension\'s commands and goes away with items', async ({ page }) => {
  await openTreeFixture(page);
  const empty = notesView(page, 'Empty Notes');
  await expect(empty.getByText('No notes <b>yet</b>.', { exact: true })).toBeVisible();
  await expect(empty.locator('b')).toHaveCount(0);
  // The workbench command the extension does not declare stays text.
  await expect(empty.getByRole('link', { name: 'save' })).toHaveCount(0);
  await expect(empty.getByText(/Or save or read/)).toBeVisible();
  await expect(empty.getByRole('link', { name: 'the guide' })).toBeVisible();
  await empty.getByRole('button', { name: 'Create Note' }).click();
  await expect(eventLog(page)).toContainText('Created a note');
  await expect(empty.getByRole('treeitem', { name: 'First note' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Create Note' })).toHaveCount(0);
});

test('after a full refresh a node with a stable id shows once under its new parent (wr-5r5z)', async ({ page }) => {
  await openTreeFixture(page);
  await item(page, 'Inbox').click();
  await item(page, 'Archive').click();
  await expect(item(page, 'Draft')).toHaveAttribute('aria-level', '2');
  await runCommand(page, 'Tree Fixture: Move Draft');
  await expect(notesTree(page).getByRole('treeitem')).toHaveText(['Inbox', 'Ideas', 'Archive', 'Draft', 'readme.md']);
  await expect(item(page, 'Draft')).toHaveCount(1);
});

test('check boxes report their state with the extension\'s objects', async ({ page }) => {
  await openTreeFixture(page);
  await item(page, 'Inbox').click();
  const checkbox = item(page, 'Draft').getByRole('checkbox');
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(eventLog(page)).toContainText('Checked: Draft=1 (same objects)');
  await item(page, 'Draft').press(' ');
  await expect(checkbox).not.toBeChecked();
  await expect(eventLog(page)).toContainText('Checked: Draft=0 (same objects)');
});

test('drags an item to another parent with the values handleDrag put in, and takes text and files from outside', async ({ page }) => {
  await openTreeFixture(page);
  await item(page, 'Inbox').click();
  await startDrag(page, item(page, 'Draft'));
  await dragOver(page, item(page, 'Archive'));
  await page.mouse.up();
  await expect(eventLog(page)).toContainText('Moved: Draft to Archive (same objects)');
  await expect(notesTree(page).getByRole('treeitem')).toHaveText(['Inbox', 'Ideas', 'Archive', 'readme.md']);

  expect(await dropFromOutside(item(page, 'Inbox'), 'outside text', { name: 'notes.txt', content: 'hello' })).toBe(true);
  await expect(eventLog(page)).toContainText('Dropped text: outside text');
  await expect(eventLog(page)).toContainText('Dropped file: notes.txt (5 bytes)');
});

test('Escape ends a tree drag, and tree, tab and editor drags do not land on each other', async ({ page }) => {
  await openTreeFixture(page);
  const dropTarget = page.locator('.drop-target');
  await startDrag(page, item(page, 'Inbox'));
  await dragOver(page, item(page, 'Archive'));
  await expect(dropTarget).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dropTarget).toHaveCount(0);
  await page.mouse.up();
  await expect(notesTree(page).getByRole('treeitem')).toHaveText(['Inbox', 'Archive', 'readme.md']);

  // A tree item over the editor area gets no drop marker there.
  const editor = page.locator('[id="workbench.parts.editor"]');
  await startDrag(page, item(page, 'Archive'));
  await dragOver(page, editor.locator('[data-group-id]').first());
  await expect(page.locator('[data-editor-drop-position]')).toHaveCount(0);
  await page.mouse.up();
  await expect(editor.getByRole('tab')).toHaveText(['Welcome']);

  // An editor tab, which carries text, is not taken by the tree that takes text from outside.
  await startDrag(page, editor.getByRole('tab', { name: 'Welcome' }));
  await dragOver(page, item(page, 'Archive'));
  await expect(dropTarget).toHaveCount(0);
  const point = await center(item(page, 'Archive'));
  await page.mouse.move(point.x, point.y + 1);
  await page.mouse.up();
  await expect(eventLog(page)).not.toContainText('Dropped text');
  await expect(editor.getByRole('tab')).toHaveText(['Welcome']);
});
