import { expect, test } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';

// The harness page is served by the development server only.
test.skip(process.env.E2E_TARGET === 'preview', 'The grid harness is not part of the production build.');

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  const response = await page.goto('/test/harness/grid.html');
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('region', { name: 'View C' })).toBeVisible();
});

test('the views tile the grid with no gap or overlap', async ({ page }) => {
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(name => box(page.getByRole('region', { name: `View ${name}` }))));
  expect(a.x).toBe(0);
  expect(a.x + a.width).toBe(b.x);
  expect(b.x).toBe(c.x);
  expect(b.y + b.height).toBe(c.y);
  expect(b.x + b.width).toBe(1000);
  expect(a.height).toBe(600);
  expect(b.height + c.height).toBe(600);
});

test('dragging the sash 100 px moves the boundary exactly 100 px', async ({ page }) => {
  const viewA = page.getByRole('region', { name: 'View A' });
  const viewB = page.getByRole('region', { name: 'View B' });
  const before = await box(viewA);
  const boundary = before.x + before.width;

  await drag(page, { x: boundary, y: before.y + 200 }, { x: boundary + 100, y: before.y + 200 });

  const a = await box(viewA);
  const b = await box(viewB);
  expect(a.width).toBe(before.width + 100);
  expect(b.x).toBe(boundary + 100);
});

test('a lying sash moves the boundary between stacked views', async ({ page }) => {
  const viewB = page.getByRole('region', { name: 'View B' });
  const viewC = page.getByRole('region', { name: 'View C' });
  const before = await box(viewB);
  const boundary = before.y + before.height;

  await drag(page, { x: before.x + 100, y: boundary }, { x: before.x + 100, y: boundary - 100 });

  expect((await box(viewB)).height).toBe(before.height - 100);
  expect((await box(viewC)).y).toBe(boundary - 100);
});

test('a drag cannot push a view below its minimum size', async ({ page }) => {
  const viewA = page.getByRole('region', { name: 'View A' });
  const viewB = page.getByRole('region', { name: 'View B' });
  const before = await box(viewA);
  const boundary = before.x + before.width;

  await drag(page, { x: boundary, y: before.y + 200 }, { x: 5, y: before.y + 200 });
  expect((await box(viewA)).width).toBe(100);

  const after = await box(viewA);
  await drag(page, { x: after.x + after.width, y: before.y + 200 }, { x: 995, y: before.y + 200 });
  expect((await box(viewB)).width).toBe(120);
});

test('the drag ends when the pointer is released', async ({ page }) => {
  const viewA = page.getByRole('region', { name: 'View A' });
  const before = await box(viewA);
  const boundary = before.x + before.width;

  await drag(page, { x: boundary, y: before.y + 200 }, { x: boundary + 50, y: before.y + 200 });
  const released = await box(viewA);
  await page.mouse.move(boundary + 250, before.y + 220, { steps: 5 });
  expect(await box(viewA)).toEqual(released);
  expect(released.width).toBe(before.width + 50);
});

test('hiding a view gives its space away and showing it brings the size back', async ({ page }) => {
  const viewB = page.getByRole('region', { name: 'View B' });
  const viewC = page.getByRole('region', { name: 'View C' });
  const before = await box(viewC);

  await page.getByRole('button', { name: 'Toggle C' }).click();
  await expect(viewC).toBeHidden();
  expect((await box(viewB)).height).toBe(600);

  await page.getByRole('button', { name: 'Toggle C' }).click();
  await expect(viewC).toBeVisible();
  expect(await box(viewC)).toEqual(before);
});
