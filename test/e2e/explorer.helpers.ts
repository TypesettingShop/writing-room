import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.js';

export const part = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);

/** The Explorer's file tree, wherever its container is. */
export function explorerTree(page: Page): Locator {
  return page.getByRole('tree', { name: 'Files Explorer' });
}

/** The tree row named `name` (a file or folder name). */
export function treeItem(page: Page, name: string): Locator {
  return explorerTree(page).getByRole('treeitem', { name, exact: true });
}

/** The inline input of the tree. */
export function explorerInput(page: Page): Locator {
  return explorerTree(page).getByRole('textbox', { name: 'Type file name. Press Enter to confirm or Escape to cancel.' });
}

/** The names of the tree's rows, top to bottom. */
export async function rowNames(page: Page): Promise<string[]> {
  return explorerTree(page).getByRole('treeitem').evaluateAll(rows => rows.map(row => row.textContent ?? ''));
}

/** Opens the context menu of the focused row (or the tree) with Shift+F10 and runs `label`. */
export async function contextMenuByKeyboard(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Shift+F10');
  const item = page.getByRole('menuitem', { name: label, exact: true });
  await expect(item).toBeVisible();
  await item.focus();
  await page.keyboard.press('Enter');
}

/** Focuses the tree row `name` and waits for its focus. */
export async function focusRow(page: Page, name: string): Promise<void> {
  const row = treeItem(page, name);
  await row.focus();
  await expect(row).toBeFocused();
}

/** The tabs of `group` but the Welcome page's. */
export function fileTabs(group: Locator): Locator {
  return group.getByRole('tab').filter({ hasNotText: 'Welcome' });
}
