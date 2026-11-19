import { expect, test, type Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';

async function openCommandPalette(page: Page) {
  await page.keyboard.press('F1');
  const input = page.getByRole('combobox');
  await expect(input).toBeVisible();
  return input;
}

test('runs mutually activating commands and keeps the API available during uninstall', async ({ page }) => {
  const location = extensionFixtureLocation('runtime') + 'lifecycle/';
  await seedInstalledExtensions(page, [{
    location: location + 'first/',
    manifest: {
      name: 'runtime-first', publisher: 'test', version: '1.0.0', browser: './extension.js',
      contributes: { commands: [{ command: 'runtime.run', title: 'Run Runtime Lifecycle' }, { command: 'runtime.first', title: 'Runtime First' }] },
    },
  }, {
    location: location + 'second/',
    manifest: {
      name: 'runtime-second', publisher: 'test', version: '1.0.0', browser: './extension.js',
      contributes: { commands: [{ command: 'runtime.second', title: 'Runtime Second' }] },
    },
  }]);
  await page.goto('/');
  const palette = await openCommandPalette(page);
  await palette.fill('Run Runtime Lifecycle');
  await palette.press('Enter');
  await expect(page.getByText('Lifecycle result: second got first')).toBeVisible();
  const uninstall = await openCommandPalette(page);
  await uninstall.fill('Uninstall Extension');
  await uninstall.press('Enter');
  const deactivated = page.waitForEvent('console', { predicate: message => message.text() === 'Lifecycle deactivated: first' });
  await page.getByRole('option', { name: /test.runtime-first/ }).click();
  await deactivated;
  const after = await openCommandPalette(page);
  await after.fill('Run Runtime Lifecycle');
  await expect(page.getByText('Run Runtime Lifecycle', { exact: true })).toHaveCount(0);
});
