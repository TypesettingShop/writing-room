import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/package.json' with { type: 'json' };

async function command(page: Page, title: string) {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

const content = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

test.beforeEach(async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('webview'), manifest }]);
  await page.goto('/');
});

test('renders extension HTML, evaluates the context menu and preserves a retained panel when it moves', async ({ page }) => {
  await command(page, 'Fixture: Open Retained Webview');
  const frame = content(page);
  const output = frame.locator('#output');
  await expect(output).toHaveText(Array.from({ length: 100 }, (_, index) => index).join(','));
  const counter = frame.getByRole('button', { name: 'Count' });
  await counter.click();
  await expect(frame.locator('#count')).toHaveText('1');
  await counter.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fixture: Webview Context Action' }).click();
  await expect(output).toHaveText('Context action ran');
  await command(page, 'Fixture: Active Webview Action');
  await expect(output).toHaveText('Active action ran');

  await page.getByRole('tab', { name: 'Welcome' }).click();
  await expect(page.locator('iframe[title="Webview"]:visible')).toHaveCount(0);
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Fixture: Active Webview Action');
  await expect(page.getByRole('option', { name: 'Fixture: Active Webview Action' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await command(page, 'Fixture: Reveal Webview Beside');
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await expect(frame.locator('#count')).toHaveText('1');
  const destination = page.locator('.editor-group-container').filter({ has: page.getByRole('tab', { name: 'Fixture retained' }) });
  const editorBody = destination.locator('.editor-container');
  const bounds = (await editorBody.boundingBox())!;
  const source = (await page.getByRole('tab', { name: 'Welcome' }).boundingBox())!;
  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const to = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 3, { steps: 3 });
  await expect(page.locator('.webview-element')).toHaveCSS('pointer-events', 'none');
  await page.mouse.move(to.x - 1, to.y);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
  await expect(destination.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await destination.getByRole('tab', { name: 'Fixture retained' }).click();
  await expect(frame.locator('#count')).toHaveText('1');
  await page.getByRole('button', { name: 'Close Fixture retained' }).click();
  await expect(page.locator('iframe[title="Webview"]')).toHaveCount(0);
});

test('discards hidden transient content, rejects its messages and emits one disposal', async ({ page }) => {
  await command(page, 'Fixture: Open Transient Webview');
  await content(page).getByRole('button', { name: 'Count' }).click();
  await expect(content(page).locator('#count')).toHaveText('1');

  await command(page, 'Fixture: Open Retained Webview');
  await expect(page.locator('iframe[title="Webview"]')).toHaveCount(1);
  await expect(content(page).getByRole('button', { name: 'Count' })).toBeVisible();
  await command(page, 'Fixture: Probe Webview State');
  await expect(content(page).locator('#output')).toHaveText('{"delivered":false,"transient":[[false,false,1]],"retained":[]}');

  await page.getByRole('tab', { name: 'Fixture transient' }).click();
  await expect(content(page).locator('#count')).toHaveText('0');
  await command(page, 'Fixture: Dispose Webview');
  await expect(page.getByRole('tab', { name: 'Fixture transient' })).toHaveCount(0);
  await command(page, 'Fixture: Probe Webview State');
  await expect(content(page).locator('#output')).toContainText('"transient":[[false,false,1],[true,true,1],"disposed"]');
});

test('renders only the owning tab icon and releases image URLs when it changes or closes', async ({ page }) => {
  const requests: string[] = [];
  page.context().on('request', request => { requests.push(request.url()); });
  const initialMessages = Array.from({ length: 100 }, (_, index) => index).join(',');
  await command(page, 'Fixture: Open Retained Webview');
  await expect(content(page).locator('#output')).toHaveText(initialMessages);
  await command(page, 'Fixture: Open Transient Webview');
  await expect(page.getByRole('tab', { name: 'Fixture transient', selected: true })).toBeVisible();
  await expect(content(page).locator('#output')).toHaveText(initialMessages);
  const tab = page.getByRole('tab', { name: 'Fixture retained', exact: true });
  const icon = tab.locator('.tab-icon');
  const image = icon.locator('img');
  const change = () => command(page, 'Fixture: Change Webview Tab Icon');

  await change();
  await expect(icon.locator('.codicon-beaker')).toBeVisible();
  await expect(tab).toHaveAccessibleName('Fixture retained');
  await expect(page.getByRole('tab', { name: 'Fixture transient' }).locator('.tab-icon')).toBeHidden();

  await change();
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(12);
  const lightUrl = (await image.getAttribute('src'))!;
  await change();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(16);
  const urlReadable = (url: string) => page.evaluate(value => fetch(value).then(response => response.ok, () => false), url);
  expect(await urlReadable(lightUrl)).toBe(false);

  await change();
  await expect(icon).toBeHidden();

  await change();
  await expect(image).toHaveAttribute('src', /^blob:/);
  const lastUrl = (await image.getAttribute('src'))!;
  expect(await urlReadable(lastUrl)).toBe(true);
  await page.getByRole('button', { name: 'Close Fixture retained' }).click();
  await expect(tab).toHaveCount(0);
  expect(await urlReadable(lastUrl)).toBe(false);
  expect(requests).not.toContain(new URL('../remote/icon.png', extensionFixtureLocation('webview')).href);
});
