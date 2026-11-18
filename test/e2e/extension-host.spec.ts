import { expect, test } from '@playwright/test';

test('starts the sample worker only when an extension command is requested', async ({ page }) => {
  const workers: string[] = [];
  const errors: string[] = [];
  page.on('worker', worker => workers.push(worker.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
  await page.goto('/');
  const action = page.getByRole('button', { name: 'Show Extension Host' });
  await expect(action).toBeVisible();
  expect(workers).toHaveLength(0);
  const connected = page.waitForEvent('worker');
  await action.click();
  const worker = await connected;
  expect(new URL(worker.url()).origin).toBe(new URL(page.url()).origin);
  await expect(page.getByText('Running in the extension Worker.')).toBeVisible();
  await expect.poll(() => worker.evaluate(() => typeof globalThis.postMessage)).toBe('undefined');
  expect(errors).toEqual([]);
});

test('hides worker globals and leaves the workbench responsive through failure, a hang and restart', async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'The failure harness is available in development');
  await page.goto('/test/harness/extension-host.html');
  expect(page.workers()).toHaveLength(0);
  const result = page.locator('#result');
  await page.locator('#fail').click();
  await expect(result).toContainText("command 'host-fixture.fail' not found");
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
  const payload = JSON.parse((await result.textContent())!);
  expect(payload).toEqual({
    worker: true, document: 'undefined', storage: 'undefined', postMessage: 'undefined',
    close: 'undefined', importScripts: 'undefined', addEventListener: 'undefined',
    requireError: "Cannot load module 'unsupported'",
    portReached: false,
  });
  await page.locator('#hang').click();
  await page.locator('#ping').click();
  await expect(page.locator('#page-result')).toHaveText('responsive');
  await expect(result).toContainText('stopped responding', { timeout: 15_000 });
  await page.locator('#run').click();
  await expect(result).toContainText('The extension host is not running');
  // Removing the hanging fixture would normally be an uninstall. Reload isolates it from the replay check.
  await page.reload();
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
  await page.locator('#crash').click();
  await expect.poll(() => page.workers().length).toBe(0);
  await page.locator('#restart').click();
  await expect.poll(() => page.workers().length).toBe(1);
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
});
