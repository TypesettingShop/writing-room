import { expect, test } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'Menu harness is available only in development');
  const response = await page.goto('/test/harness/menus.html');
  expect(response?.ok()).toBe(true);
});

test('runs a menu command once and restores focus on close', async ({ page }) => {
  const original = page.getByRole('textbox', { name: 'Original focus' });
  await original.focus();
  const bar = page.getByRole('menubar');
  await expect(bar.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0);
  await bar.getByRole('menuitem', { name: 'File' }).click();
  const popup = page.getByRole('menu', { name: 'File' });
  const unavailable = popup.getByRole('menuitem', { name: 'Unavailable' });
  const draft = popup.getByRole('menuitem', { name: 'New Draft' });
  await expect(unavailable).toHaveAttribute('aria-disabled', 'true');
  await expect(draft).toContainText('Ctrl+F8');
  await unavailable.click({ force: true });
  await expect(page.getByRole('status')).toHaveText('0');
  await page.keyboard.press('ArrowDown');
  await expect(draft).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(original).toBeFocused();
  await expect(popup).toHaveCount(0);
  await bar.getByRole('menuitem', { name: 'File' }).click();
  await page.keyboard.press('Enter');
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('1');
  await expect(original).toBeFocused();
  await bar.getByRole('menuitem', { name: 'File' }).click();
  const elsewhere = page.getByRole('button', { name: 'Context Target' });
  await elsewhere.click();
  await expect(popup).toHaveCount(0);
  await expect(elsewhere).toBeFocused();
});

test('reacts to registry and context changes and navigates nested menus', async ({ page }) => {
  const bar = page.getByRole('menubar');
  await page.getByRole('button', { name: 'Toggle Edit Visibility' }).click();
  await page.getByRole('button', { name: 'Add Help Item' }).click();
  await expect(bar.getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Help']);
  await bar.getByRole('menuitem', { name: 'File' }).click();
  await bar.getByRole('menuitem', { name: 'Edit' }).hover();
  await expect(page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const appearance = page.getByRole('menuitem', { name: 'Appearance' });
  await expect(appearance).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const grid = page.getByRole('menuitemcheckbox', { name: 'Show Grid' });
  await expect(grid).toHaveAttribute('aria-checked', 'true');
  await expect(grid).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(appearance).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('keeps a corner context menu on screen and moves secondary actions into toolbar overflow', async ({ page }) => {
  const toolbar = page.getByRole('toolbar');
  await expect(toolbar.getByRole('button', { name: 'New Draft' })).toHaveAttribute('title', 'New Draft');
  await expect(toolbar.getByRole('button', { name: 'Edit Draft' })).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'More Actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit Draft' }).click();
  await expect(page.getByRole('status')).toHaveText('1');
  await page.getByRole('button', { name: 'Context Target' }).click({ button: 'right', position: { x: 90, y: 15 } });
  const menu = page.getByRole('menu');
  const bounds = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.getByRole('textbox', { name: 'Original focus' }).click();
  await expect(menu).toHaveCount(0);
});
