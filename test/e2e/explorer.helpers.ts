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

/** The attribute that marks where files dragged in from the computer would go. */
export const DROP_TARGET_ATTRIBUTE = 'data-explorer-drop-target';

/** A file to drag in: its text, its bytes, or `size` zero bytes made in the page. */
export interface DraggedFile {
  readonly name: string;
  readonly text?: string;
  readonly bytes?: readonly number[];
  readonly size?: number;
}

export interface FileDragResult {
  /** Whether a listener took each event (`preventDefault`), in order. */
  readonly taken: readonly boolean[];
}

/**
 * Sends `events` (`dragenter`, `dragover`, `dragleave`, `drop`) to `target` as a browser does for files
 * dragged in from the computer, all with one DataTransfer holding `files`. A `dragleave` goes to
 * `leaveTo` (`relatedTarget`), or out of the window.
 */
export async function dragFiles(
  target: Locator, events: readonly string[], files: readonly DraggedFile[], leaveTo?: Locator,
): Promise<FileDragResult> {
  const related = leaveTo ? await leaveTo.elementHandle() : null;
  return target.evaluate((element, { events, files, related }) => {
    const data = new DataTransfer();
    for (const file of files) {
      const content = file.text !== undefined ? new TextEncoder().encode(file.text)
        : file.bytes ? new Uint8Array(file.bytes) : new Uint8Array(file.size ?? 0);
      data.items.add(new File([content], file.name));
    }
    const bounds = element.getBoundingClientRect();
    const taken: boolean[] = [];
    for (const type of events) {
      const event = new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: data,
        clientX: bounds.left + Math.min(20, bounds.width / 2), clientY: bounds.top + Math.min(5, bounds.height / 2),
        relatedTarget: type === 'dragleave' ? related : null,
      });
      taken.push(!element.dispatchEvent(event));
    }
    return { taken };
  }, { events, files, related });
}
