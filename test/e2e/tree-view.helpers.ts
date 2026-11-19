import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { box, expect } from './fixtures.js';

export { runCommand } from './window-ui.helpers.js';

const manifest = JSON.parse(readFileSync(
  new URL('../fixtures/extensions/theming/tree-view/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

/** Installs the tree view fixture before the workbench starts, opens the app and shows the fixture's views. */
export async function openTreeFixture(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('theming') + 'tree-view/', manifest }]);
  await page.goto('/');
  await activityButton(page, 'Tree Fixture').click();
  await expect(notesTree(page).getByRole('treeitem', { name: 'Inbox' })).toBeVisible();
}

export const activityButton = (page: Page, name: string): Locator =>
  page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name });

export const notesView = (page: Page, name = 'Notes'): Locator => page.getByRole('region', { name });
export const notesTree = (page: Page): Locator => notesView(page).getByRole('tree');
export const item = (page: Page, name: string): Locator => notesTree(page).getByRole('treeitem', { name, exact: true });

/** The fixture's event log in the status bar, which holds its last twelve events. */
export const eventLog = (page: Page): Locator => page.locator('[id="workbench.parts.statusbar"]');

export async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const bounds = await box(locator);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Presses the mouse on `from` and moves off it, so the browser starts a drag. */
export async function startDrag(page: Page, from: Locator): Promise<void> {
  const point = await center(from);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 6, point.y + 3, { steps: 3 });
}

/** Two moves, so the target sees `dragenter` and `dragover`. */
export async function dragOver(page: Page, to: Locator): Promise<void> {
  const point = await center(to);
  await page.mouse.move(point.x - 1, point.y);
  await page.mouse.move(point.x, point.y);
}

/** Dispatches a drop from outside the window on `target`, carrying `text` and a file. */
export function dropFromOutside(target: Locator, text: string, file: { name: string; content: string }): Promise<boolean> {
  return target.evaluate((element, { text, file }) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    data.items.add(new File([file.content], file.name));
    const bounds = element.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: bounds.left + 5, clientY: bounds.top + 5 };
    element.dispatchEvent(new DragEvent('dragenter', init));
    const over = new DragEvent('dragover', init);
    element.dispatchEvent(over);
    element.dispatchEvent(new DragEvent('drop', init));
    return over.defaultPrevented;
  }, { text, file });
}
