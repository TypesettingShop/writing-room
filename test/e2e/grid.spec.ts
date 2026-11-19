import { box, drag, expect, test } from './fixtures.js';

// The harness page is served by the development server only.
test.skip(process.env.E2E_TARGET === 'preview', 'The grid harness is not part of the production build.');

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

  await drag(page, boundary, before.y + 200, boundary + 100, before.y + 200);

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

  await drag(page, before.x + 100, boundary, before.x + 100, boundary - 100);

  expect((await box(viewB)).height).toBe(before.height - 100);
  expect((await box(viewC)).y).toBe(boundary - 100);
});

test('a drag cannot push a view below its minimum size', async ({ page }) => {
  const viewA = page.getByRole('region', { name: 'View A' });
  const viewB = page.getByRole('region', { name: 'View B' });
  const before = await box(viewA);
  const boundary = before.x + before.width;

  await drag(page, boundary, before.y + 200, 5, before.y + 200);
  expect((await box(viewA)).width).toBe(100);

  const after = await box(viewA);
  await drag(page, after.x + after.width, before.y + 200, 995, before.y + 200);
  expect((await box(viewB)).width).toBe(120);
});

test('the drag ends when the pointer is released', async ({ page }) => {
  const viewA = page.getByRole('region', { name: 'View A' });
  const before = await box(viewA);
  const boundary = before.x + before.width;

  await drag(page, boundary, before.y + 200, boundary + 50, before.y + 200);
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
