import { expect, test } from '@playwright/test';
import { outputView, runCommand } from './window-ui.helpers.js';

test('starts the sample worker on demand and exposes a served extension directory', async ({ page }) => {
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
  const message = page.getByText('Running in the extension Worker.');
  await expect(message).toBeVisible();
  const location = (await message.textContent())!.split('Directory: ')[1];
  expect(new URL(location).href).toBe(new URL('/extensions/hello-world/', page.url()).href);
  const manifest = await page.request.get(new URL('package.json', location).href);
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ name: 'hello-world', browser: './extension.js' });
  const entry = await page.request.get(new URL('extension.js', location).href);
  expect(entry.ok()).toBe(true);
  expect(await entry.text()).toContain('exports.activate');
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
  await page.locator('#restart').click();
  await expect.poll(() => page.workers().length).toBe(1);
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
});

test('logs uncaught extension callback errors without interrupting another extension', async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'The failure harness is available in development');
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
  await page.goto('/test/harness/extension-host.html');
  const result = page.locator('#result');
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
  const worker = page.workers()[0];
  await page.locator('#async-error').click();
  const output = outputView(page);
  if (!await output.tab.isVisible()) {
    await runCommand(page, 'View: Toggle Panel Visibility');
  }
  await expect(output.tab).toHaveAttribute('aria-selected', 'true');
  await expect(output.channels.getByRole('option', { name: 'Extension Host (Worker)', exact: true }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(output.log).toContainText('[writing-room-tests.async-error] Uncaught error in the extension worker: Error: Fixture asynchronous error');
  await expect(output.log).toContainText('[writing-room-tests.async-error] Unhandled promise rejection in the extension worker: Error: Fixture rejected promise');
  expect(errors).toEqual([]);
  expect(page.workers()).toEqual([worker]);
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
});

test('recovers from explicit worker termination', async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'The failure harness is available in development');
  await page.goto('/test/harness/extension-host.html');
  const result = page.locator('#result');
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
  const closed = page.workers()[0].waitForEvent('close');
  await page.locator('#crash').click();
  await closed;
  await page.locator('#run').click();
  await expect(result).toContainText('The extension host is not running', { timeout: 15_000 });
  await page.locator('#restart').click();
  await expect.poll(() => page.workers().length).toBe(1);
  await page.locator('#run').click();
  await expect(result).toContainText('"worker":true');
});
