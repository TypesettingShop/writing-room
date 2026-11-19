import { expect, test } from '@playwright/test';
import { bundleWebviewHarness, openWebviewHarness } from './webview-harness.helpers.js';

let harnessCode: string;
test.beforeAll(async () => {
  harnessCode = await bundleWebviewHarness();
});

test('isolates the workbench, serves the first bounded resource and exchanges messages', async ({ page }) => {
  await openWebviewHarness(page, '/', harnessCode);
  const extensionOrigin = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT;
  await page.evaluate(extensionOrigin => {
    const harness = (window as any).harness;
    const script = harness.asWebviewUri(extensionOrigin + '/webview/first.js');
    const root = extensionOrigin + '/webview';
    harness.set(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${new URL(script).origin}">
      <script src="${script}"></script>
      <a href="https://example.com/somewhere" target="_top">Open external</a>`, true, root);
  }, extensionOrigin);
  const shell = page.locator('iframe[title="Webview"]');
  const appUrl = page.url();
  const shellOrigin = new URL((await shell.getAttribute('src'))!).origin;
  expect(shellOrigin).not.toBe(new URL(appUrl).origin);
  const content = page.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]');
  await expect(content.locator('body')).toHaveClass('vscode-dark');
  await expect.poll(() => page.evaluate(() => (window as any).harness.messages)).toEqual([
    { resource: true, documentBlocked: true, storageBlocked: true, singleAcquire: true },
  ]);

  expect(page.url()).toBe(appUrl);
  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Webview"]')!;
    const shell = new URL(iframe.src);
    // A synthetic handshake and an event without the negotiated port cannot deliver content.
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: shell.origin,
      data: { type: 'connect', token: shell.hash.slice(1) },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: shell.origin,
      data: { type: 'message', value: 'forged' },
    }));
  });

  const received = await page.evaluate(async () => {
    const harness = (window as any).harness;
    return await Promise.all(Array.from({ length: 100 }, (_, id) => harness.send(id)));
  });
  expect(received).toEqual(Array(100).fill(true));
  await expect.poll(() => page.evaluate(() => (window as any).harness.messages.slice(1)))
    .toEqual(Array.from({ length: 100 }, (_, id) => id));

  await content.getByText('Open external').click();
  await expect.poll(() => page.evaluate(() => (window as any).harness.links)).toEqual(['https://example.com/somewhere']);
  await page.keyboard.press('F1');
  await expect(page.getByRole('combobox', { name: 'Type a command' })).toBeFocused();

  await page.evaluate(() => (window as any).harness.dispose());
  await expect(shell).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).harness.send('disposed'))).toBe(false);
});

test('renders with scripts disabled and shows same-origin configuration errors', async ({ page }) => {
  await openWebviewHarness(page, '/', harnessCode);
  await page.evaluate(root => {
    const harness = (window as any).harness;
    const stylesheet = harness.asWebviewUri(root + '/plain.css');
    harness.set('<link rel="stylesheet" href="' + stylesheet + '">'
      + '<p class="test-scriptless">Scriptless</p><script>document.body.append("Unexpected script");</script>',
    false, root);
  }, 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT + '/webview');
  const content = page.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]');
  await expect(content.getByText('Scriptless')).toBeVisible();
  await expect(content.getByText('Scriptless')).toHaveCSS('color', 'rgb(12, 34, 56)');
  await expect(content.getByText('Unexpected script')).toHaveCount(0);

  const appOrigin = new URL(page.url()).origin;
  await openWebviewHarness(page, '/?template=' + encodeURIComponent(appOrigin), harnessCode);
  await expect(page.locator('.webview-element').getByRole('status')).toContainText('separate origin');
  await expect(page.locator('iframe')).toHaveCount(0);
});
