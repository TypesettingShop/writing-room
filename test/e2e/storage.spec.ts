import type { Page } from '@playwright/test';
import { collectPageErrors, expect, test } from './fixtures.js';

const harness = '/test/harness/storage.html';

async function openHarness(page: Page): Promise<void> {
  expect((await page.goto(harness))?.ok()).toBe(true);
  await expect(page.getByRole('status')).toContainText('"changes":[]');
}

async function store(page: Page, key: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Key' }).fill(key);
  await page.getByRole('textbox', { name: 'Value' }).fill(value);
  await page.getByRole('button', { name: 'Store value' }).click();
}

if (process.env.E2E_TARGET === 'preview') {
  test('keeps the storage harness out of the production build', async ({ request }) => {
    expect((await request.get(harness)).status()).toBe(404);
  });
} else {
  test('stores and removes a value across page reloads', async ({ page }) => {
    await openHarness(page);
    const result = page.getByRole('status');
    await store(page, 'state', 'saved in browser');
    await expect(result).toContainText('"state":"saved in browser"');
    await page.reload();
    await expect(result).toHaveText('{"state":"saved in browser","other":"","changes":[]}');

    await page.getByRole('button', { name: 'Remove value' }).click();
    await expect(result).toContainText('"state":""');
    await page.reload();
    await expect(result).toHaveText('{"state":"","other":"","changes":[]}');
  });

  test('shares independent writes across tabs and converges on the last write to the same key', async ({ page, context }) => {
    const second = await context.newPage();
    // The pageErrors fixture watches only the first page.
    const secondErrors = collectPageErrors(second);
    try {
      await Promise.all([openHarness(page), openHarness(second)]);
      const firstResult = page.getByRole('status');
      const secondResult = second.getByRole('status');
      await Promise.all([store(page, 'state', 'tab A'), store(second, 'other', 'tab B')]);
      await expect(firstResult).toContainText('"other":"tab B"');
      await expect(firstResult).toContainText('external:other');
      await expect(secondResult).toContainText('"state":"tab A"');
      await expect(secondResult).toContainText('external:state');

      await store(second, 'state', 'tab B last');
      await expect(firstResult).toContainText('"state":"tab B last"');
      await page.reload();
      await expect(firstResult).toHaveText('{"state":"tab B last","other":"tab B","changes":[]}');
      expect(secondErrors.errors, 'Second page errors and console errors').toEqual([]);
    } finally {
      await second.close();
    }
  });
}
