import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

const part = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function drag(page: Page, x: number, y: number, toX: number, toY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 8 });
  await page.mouse.up();
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 600 }]) {
  test.describe(`${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });

    test('the six workbench parts tile the viewport', async ({ appPage: page }) => {
      const names = ['titlebar', 'activitybar', 'sidebar', 'editor', 'panel', 'statusbar'];
      for (const name of names) {
        await expect(part(page, name)).toHaveCount(1);
        await expect(part(page, name)).toHaveAttribute('role', name === 'statusbar' ? 'status' : name === 'editor' ? 'main' : 'none');
      }
      const [titlebar, activitybar, sidebar, editor, panel, statusbar] =
        await Promise.all(names.map(name => box(part(page, name))));
      const width = viewport.width;
      const height = viewport.height;
      const sidebarWidth = Math.min(300, width / 4);
      const editorWidth = width - 48 - sidebarWidth;
      const panelHeight = Math.round(height / 3);
      const editorHeight = height - 30 - 22 - panelHeight;

      expect(titlebar).toEqual({ x: 0, y: 0, width, height: 30 });
      expect(activitybar).toEqual({ x: 0, y: 30, width: 48, height: height - 52 });
      expect(sidebar).toEqual({ x: 48, y: 30, width: sidebarWidth, height: height - 52 });
      expect(editor).toEqual({ x: 48 + sidebarWidth, y: 30, width: editorWidth, height: editorHeight });
      expect(panel).toEqual({ x: 48 + sidebarWidth, y: 30 + editorHeight, width: editorWidth, height: panelHeight });
      expect(statusbar).toEqual({ x: 0, y: height - 22, width, height: 22 });
    });
  });
}

test('the sidebar and panel boundaries drag to their minimum sizes', async ({ appPage: page }) => {
  const sidebar = part(page, 'sidebar');
  const panel = part(page, 'panel');
  const start = await box(sidebar);
  const boundary = start.x + start.width;
  await drag(page, boundary, 175, boundary + 120, 175);
  expect((await box(sidebar)).width).toBe(start.width + 120);

  await drag(page, boundary + 120, 175, 100, 175);
  expect((await box(sidebar)).width).toBe(170);

  const bounds = await box(panel);
  await drag(page, bounds.x + 120, bounds.y, bounds.x + 120, bounds.y + bounds.height - 10);
  expect((await box(panel)).height).toBe(77);
});

test('Appearance reflects the sidebar state and restores its dragged width', async ({ appPage: page }) => {
  const sidebar = part(page, 'sidebar');
  const editor = part(page, 'editor');
  const start = await box(sidebar);
  const boundary = start.x + start.width;
  await drag(page, boundary, 175, boundary + 70, 175);
  const resized = await box(sidebar);
  expect(resized.width).toBe(start.width + 70);
  const menu = page.getByRole('menubar');
  const checkbox = page.getByRole('menuitemcheckbox', { name: 'Primary Side Bar' });

  async function openAppearance() {
    await menu.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  }

  await openAppearance();
  await expect(checkbox).toHaveAttribute('aria-checked', 'true');
  await checkbox.click();
  await expect(sidebar).toBeHidden();
  expect((await box(editor)).x).toBe(48);

  await openAppearance();
  await expect(checkbox).toHaveAttribute('aria-checked', 'false');
  await checkbox.click();
  await expect(sidebar).toBeVisible();
  expect(await box(sidebar)).toEqual(resized);

  await openAppearance();
  await expect(checkbox).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
});

test('Explorer exposes an icon and opens or closes the sidebar, and tabs switch the panel', async ({ appPage: page }) => {
  const activitybar = part(page, 'activitybar');
  const sidebar = part(page, 'sidebar');
  const panel = part(page, 'panel');
  const explorer = activitybar.getByRole('button', { name: 'Explorer', exact: true });
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');
  const hasGlyph = await explorer.locator('[aria-hidden="true"]').evaluate(async element => {
    const faces = await document.fonts.load('24px codicon');
    const glyph = getComputedStyle(element, '::before').content.slice(1, -1).codePointAt(0) ?? 0;
    return faces.some(face => face.status === 'loaded') && glyph >= 0xe000 && glyph <= 0xf8ff;
  });
  expect(hasGlyph).toBe(true);
  await explorer.click();
  await expect(sidebar).toBeHidden();
  await expect(explorer).toHaveAttribute('aria-pressed', 'false');
  await explorer.click();
  await expect(sidebar.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(explorer).toHaveAttribute('aria-pressed', 'true');

  const output = panel.getByRole('tab', { name: 'Output' });
  const problems = panel.getByRole('tab', { name: 'Problems' });
  await expect(output).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('No output yet')).toBeVisible();
  await problems.click();
  await expect(problems).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('No problems detected')).toBeVisible();
  await expect(panel.getByText('No output yet')).toBeHidden();

  await problems.press('ArrowLeft');
  await expect(output).toBeFocused();
  await expect(output).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('No output yet')).toBeVisible();
});

test('a late sidebar registration appears in the Activity Bar and can be opened', async ({ appPage: page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'Source modules are available on the development server.');
  await page.evaluate(async () => {
    const path = '/src/workbench/common/views.ts';
    const { ViewContainerLocation, viewContainersRegistry, viewsRegistry } = await import(path);
    const container = viewContainersRegistry.registerViewContainer({
      id: 'test.search', title: 'Search', icon: '$(search)',
    }, ViewContainerLocation.Sidebar);
    viewsRegistry.registerViews([{
      id: 'test.search.results',
      name: 'Results',
      renderBody(parent: HTMLElement) { parent.textContent = 'No matches'; },
    }], container);
  });

  const activitybar = part(page, 'activitybar');
  const sidebar = part(page, 'sidebar');
  const search = activitybar.getByRole('button', { name: 'Search' });
  await search.click();
  await expect(sidebar.getByText('No matches')).toBeVisible();
  await expect(search).toHaveAttribute('aria-pressed', 'true');
  await expect(activitybar.getByRole('button', { name: 'Explorer' })).toHaveAttribute('aria-pressed', 'false');
  await search.click();
  await expect(sidebar).toBeHidden();
  await activitybar.getByRole('button', { name: 'Explorer' }).click();
  await expect(sidebar.getByRole('heading', { name: 'Files' })).toBeVisible();
});

test('workbench shortcuts toggle the sidebar and panel', async ({ appPage: page }) => {
  for (const [key, name] of [['Control+b', 'sidebar'], ['Control+j', 'panel']]) {
    await page.keyboard.press(key);
    await expect(part(page, name)).toBeHidden();
    await page.keyboard.press(key);
    await expect(part(page, name)).toBeVisible();
  }
});

test('resizing keeps fixed bars at the viewport edges and the document does not scroll', async ({ appPage: page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(() => box(part(page, 'statusbar'))).toEqual({ x: 0, y: 578, width: 800, height: 22 });
  expect(await box(part(page, 'titlebar'))).toEqual({ x: 0, y: 0, width: 800, height: 30 });
  await page.mouse.move(400, 400);
  await page.mouse.wheel(500, 500);
  const documentSize = await page.evaluate(() => ({
    x: window.scrollX, y: window.scrollY,
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
  }));
  expect(documentSize).toEqual({ x: 0, y: 0, width: 800, height: 600 });
});
