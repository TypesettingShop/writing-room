import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { runCommand, startWithMarkdownSource } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { groups, listBackups, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';

const richEditor = (scope: Locator) => scope.getByRole('textbox', { name: 'Markdown editor' });

async function openMarkdown(page: Page, name: string, text: string): Promise<Locator> {
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, text);
  await treeItem(page, name).dblclick();
  return groups(page).first();
}

test('opens Markdown from Explorer and carries its draft and saved text through reloads', async ({ appPage: page }) => {
  const name = 'draft.markdown';
  const group = await openMarkdown(page, name, 'First\n=====\n\nHello\n');
  const editor = richEditor(group);
  await expect(editor.getByRole('heading', { name: 'First' })).toBeVisible({ timeout: 20_000 });
  await expect(selectedTab(group)).toHaveText(name);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  await expect(editor.locator('p')).toHaveText('Hello world', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  expect(await readWorkspaceText(page, name)).toBe('First\n=====\n\nHello\n');

  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('First\n=====\n\nHello world\n');
  await page.reload();
  await expect(editor.locator('p')).toHaveText('Hello world', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('switches the active tab in place, keeps its draft and takes the caret near the same block', async ({ appPage: page }) => {
  const name = 'switch.md';
  const group = await openMarkdown(page, name, '# Heading\n\nFirst paragraph\n\nSecond paragraph\n');
  const editor = richEditor(group);
  await editor.getByText('Second paragraph').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' draft');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  const tabs = await group.getByRole('tab').allTextContents();
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type(' edit');
  await treeItem(page, name).dblclick();
  await expect(group.locator('.view-lines')).toContainText('Second paragraph draft edit');
  await expect(group.getByRole('tab')).toHaveText(tabs);
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  await expect(group.locator('.view-lines')).toContainText('Second paragraph draft edit', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  await runCommand(page, 'Toggle Source Mode', /Markdown: Toggle Source Mode/);
  await expect(editor.getByText('Second paragraph draft edit')).toBeVisible();
  await expect(group.getByRole('tab')).toHaveText(tabs);
});

test('honors the Source default and still allows explicit WYSIWYG', async ({ page }) => {
  await startWithMarkdownSource(page);
  await page.goto('/');
  const group = await openMarkdown(page, 'source.md', '# Heading');
  await expect(group.locator('.view-lines')).toContainText('# Heading', { timeout: 20_000 });
  await group.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await expect(richEditor(group).getByRole('heading', { name: 'Heading' })).toBeVisible();
});

test('keeps split source and WYSIWYG views synchronized on one dirty model', async ({ appPage: page }) => {
  const name = 'split.md';
  const left = await openMarkdown(page, name, '# Heading\n\nShared');
  await expect(richEditor(left).getByText('Shared')).toBeVisible({ timeout: 20_000 });
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const right = groups(page).nth(1);
  await expect(richEditor(right).getByText('Shared')).toBeVisible();
  await right.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(right.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' source');
  await expect(richEditor(left).getByText('Shared source')).toBeVisible();
  await expect(selectedTab(left)).toHaveAccessibleDescription('Modified');

  await richEditor(left).getByText('Shared source').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' rich');
  await expect(right.locator('.view-lines')).toContainText('Shared source rich');
  await left.getByRole('button', { name: 'Close split.md' }).click();
  await expect(page.getByRole('tab', { name })).toHaveCount(1);
  await expect(page.getByRole('tab', { name })).toHaveAccessibleDescription('Modified');
});


async function editHistoryMenu(page: Page, item: 'Undo' | 'Redo'): Promise<void> {
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('undoes and redoes typing and formatting through the keyboard and Edit menu, including after save', async ({ appPage: page }) => {
  const name = 'history.md';
  const group = await openMarkdown(page, name, 'Hello');
  const editor = richEditor(group);
  await expect(editor.getByText('Hello')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await page.keyboard.press('Shift+Home');
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<p>Hello <strong>world</strong></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true, bubbles: true }));
  });
  await expect(editor.locator('strong')).toHaveText('world');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('Hello **world**');

  await editHistoryMenu(page, 'Undo');
  await expect(editor.locator('strong')).toHaveCount(0);
  await expect(editor).toHaveText('Hello world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Hello');

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveText('Hello world');
  await editHistoryMenu(page, 'Redo');
  await expect(editor.locator('strong')).toHaveText('world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('starts a new history at the current text when switching between modes', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'boundary.md', 'Start');
  const editor = richEditor(group);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' rich');
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });

  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toContainText('Start rich');
  await page.keyboard.type(' source');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich source');

  await group.getByRole('button', { name: 'Switch to WYSIWYG' }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Start rich source');
  await page.keyboard.type(' later');
  await expect(editor).toHaveText('Start rich source later');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Start rich source');
});
