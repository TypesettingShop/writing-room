import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/view/package.json' with { type: 'json' };

async function toggleSidebar(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Primary Side Bar' }).click();
}

test('resolves an owned view, moves a live view to the panel and restores its JSON state', async ({ page }) => {
  const location = new URL('view/', extensionFixtureLocation('webview')).href;
  await seedInstalledExtensions(page, [{ location, manifest }]);
  await page.goto('/');
  const container = page.getByRole('button', { name: 'Webview View Fixture', exact: true });
  await container.click();
  const shell = page.locator('iframe[title="Webview"]');
  const content = page.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]');
  const increment = content.getByRole('button', { name: 'Increment view' });
  await expect(content.getByText('Ownership checked')).toBeVisible();
  await expect(content.getByText('Resolved')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Webview Counter' })).toHaveAttribute('title', /supplied by the fixture/);
  await expect(page.getByText('No Webview content.')).toBeVisible();
  await increment.click();
  await expect(content.locator('#count')).toHaveText('1');

  await toggleSidebar(page);
  await expect(shell).toBeHidden();
  await toggleSidebar(page);
  await expect(increment).toBeVisible();
  await expect(content.locator('#visibility')).toHaveText('[false,true]');

  const source = await shell.getAttribute('src');
  await container.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Panel' }).click();
  const panel = page.locator('[id="workbench.parts.panel"]');
  const view = panel.getByRole('heading', { name: 'Webview Counter' });
  await expect(view).toBeVisible();
  await expect(shell).toHaveAttribute('src', source!);
  await expect(content.locator('#count')).toHaveText('1');
  await expect(content.locator('#visibility')).toHaveText('[false,true]');
  const rect = await shell.boundingBox();
  const panelRect = await panel.boundingBox();
  expect(rect?.y).toBeGreaterThanOrEqual(panelRect!.y);

  await page.reload();
  await expect(content.locator('#state')).toHaveText('1');
  await expect(content.locator('#count')).toHaveText('1');
});
