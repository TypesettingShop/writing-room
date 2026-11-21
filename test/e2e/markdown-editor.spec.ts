import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
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
