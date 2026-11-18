import { box, drag, expect, renderedText, test } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

const groups = (page: Page) => page.locator('[data-group-id]');
const group = (page: Page, index = 0) => groups(page).nth(index);
const textbox = (scope: Locator) => scope.getByRole('textbox', { name: 'Editor content' });

async function newTextFile(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
}

/** Opens a new untitled editor in the active group and types into it. */
async function openAndType(page: Page, text?: string): Promise<void> {
  await newTextFile(page);
  // The first editor waits for Monaco to load, which a cold dev server under a full run can take a while over.
  await expect(textbox(page.locator('[data-group-id]').first())).toBeFocused({ timeout: 20_000 });
  if (text !== undefined) {
    await page.keyboard.type(text);
  }
}

test('New Text File adds a focused, dirty-on-typing tab', async ({ appPage: page }) => {
  const g = group(page);
  await expect(g.getByRole('tab', { name: 'Welcome' })).toHaveAttribute('aria-selected', 'true');
  await expect(g.getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' })).toBeVisible();

  await newTextFile(page);
  const tab = g.getByRole('tab', { name: 'Untitled-1' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(textbox(g)).toBeFocused({ timeout: 20_000 });
  await expect(tab).not.toHaveAccessibleDescription('Modified');
  await page.keyboard.type('hello');
  await expect(tab).toHaveAccessibleDescription('Modified');
  await expect.poll(() => renderedText(g)).toBe('hello');
});

test('tabs switch content and close without activating background tabs', async ({ appPage: page }) => {
  const g = group(page);
  await openAndType(page, 'alpha');
  await openAndType(page, 'beta');
  await expect.poll(() => renderedText(g)).toBe('beta');

  await g.getByRole('tab', { name: 'Untitled-1' }).click();
  await expect(g.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(g)).toBe('alpha');
  await g.getByRole('tab', { name: 'Untitled-2' }).click();
  await expect.poll(() => renderedText(g)).toBe('beta');
  await g.getByRole('tab', { name: 'Untitled-1' }).click();
  await expect.poll(() => renderedText(g)).toBe('alpha');

  // Closing a background tab keeps the active one.
  await g.getByRole('tab', { name: 'Welcome' }).click({ button: 'middle' });
  await expect(g.getByRole('tab', { name: 'Welcome' })).toHaveCount(0);
  await expect(g.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');

  await openAndType(page, 'gamma');
  await g.getByRole('tab', { name: 'Untitled-2' }).click({ button: 'middle' });
  await expect(g.getByRole('tab', { name: 'Untitled-2' })).toHaveCount(0);
  await expect(g.getByRole('tab', { name: 'Untitled-3' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(g)).toBe('gamma');
  await expect(g.getByRole('tab')).toHaveCount(2);

  // The close button also closes a background tab without activating it.
  await g.getByRole('button', { name: 'Close Untitled-1' }).click();
  await expect(g.getByRole('tab', { name: 'Untitled-1' })).toHaveCount(0);
  await expect(g.getByRole('tab', { name: 'Untitled-3' })).toHaveAttribute('aria-selected', 'true');
});

test('Split Editor Right shares the model and closing the last tab removes the group', async ({ appPage: page }) => {
  await openAndType(page, 'shared');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const right = group(page, 1);
  await expect(right.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(right)).toBe('shared');

  await right.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => renderedText(right)).toBe('shared!');
  await expect.poll(() => renderedText(group(page, 0))).toBe('shared!');

  await right.getByRole('button', { name: 'Close Untitled-1' }).click();
  await expect(groups(page)).toHaveCount(1);
  await expect(group(page).getByRole('tab', { name: 'Untitled-1' })).toBeVisible();
});

test('the active tab stays visible with twenty tabs open', async ({ appPage: page }) => {
  test.setTimeout(90_000);
  for (let i = 0; i < 20; i++) {
    await newTextFile(page);
    await expect(group(page).getByRole('tab', { name: `Untitled-${i + 1}` })).toHaveAttribute('aria-selected', 'true');
  }
  const g = group(page);
  const list = g.getByRole('tablist', { name: 'Open Editors' });
  const within = async (tab: Locator) => {
    const [t, l] = [await box(tab), await box(list)];
    expect(t.x).toBeGreaterThanOrEqual(l.x - 1);
    expect(t.x + t.width).toBeLessThanOrEqual(l.x + l.width + 1);
  };
  await expect(async () => within(g.getByRole('tab', { name: 'Untitled-20' }))).toPass();

  // Scroll back, then a new editor must scroll its tab into view again.
  await list.evaluate(el => { el.scrollLeft = 0; });
  await newTextFile(page);
  const last = g.getByRole('tab', { name: 'Untitled-21' });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(async () => within(last)).toPass();
});

test('the tab context menu closes the other tabs', async ({ appPage: page }) => {
  const g = group(page);
  for (const text of ['one', 'two', 'three']) {
    await openAndType(page, text);
  }
  await g.getByRole('tab', { name: 'Untitled-2' }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  for (const name of ['Close', 'Close Others', 'Close All']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await menu.getByRole('menuitem', { name: 'Close Others', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(g.getByRole('tab')).toHaveCount(1);
  await expect(g.getByRole('tab', { name: 'Untitled-2' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => renderedText(g)).toBe('two');
});

test('dragging the sash respects the minimum width and the editor follows its group', async ({ appPage: page }) => {
  await openAndType(page, 'wide');
  await group(page).getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  const [left, right] = [group(page, 0), group(page, 1)];
  await expect.poll(() => renderedText(right)).toBe('wide');

  const sync = async (pane: Locator) => {
    await expect(async () => {
      const [g, m] = [await box(pane), await box(pane.locator('.monaco-editor').first())];
      expect(Math.abs(g.width - m.width)).toBeLessThanOrEqual(4);
    }).toPass();
  };

  const start = await box(left);
  const y = start.y + start.height / 2;
  await drag(page, start.x + start.width, y, 0, y);
  const l1 = await box(left);
  const r1 = await box(right);
  expect(l1.width).toBeGreaterThanOrEqual(220);
  expect(l1.width).toBeLessThan(start.width);
  expect(r1.width).toBeGreaterThan(start.width);
  await sync(left);
  await sync(right);

  await drag(page, l1.x + l1.width, y, 1279, y);
  const r2 = await box(right);
  expect(r2.width).toBeGreaterThanOrEqual(220);
  expect(r2.width).toBeLessThan(r1.width);
  await sync(left);
  await sync(right);
});

test('the text editor and its worker load in the built app too', async ({ appPage: page }) => {
  test.setTimeout(120_000);
  const started = page.waitForEvent('worker', { predicate: worker => worker.url().includes('editor.worker'), timeout: 60_000 });
  await openAndType(page, 'built');
  await expect.poll(() => renderedText(group(page))).toBe('built');
  const worker = await started;
  expect(worker.url()).toContain('editor.worker');
  expect(page.workers().some(w => w.url().includes('editor.worker'))).toBe(true);
});
