import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { createServer as devServer, preview } from 'vite';
import { openForwardingProxy } from '../fixtures/forwarding-proxy.mjs';
import { seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/package.json' with { type: 'json' };
import { bundleWebviewHarness, openWebviewHarness } from './webview-harness.helpers.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a loopback port');
  }
  return address.port;
}

async function openApp(port: number, webviewPort: number) {
  const old = process.env.WRITING_ROOM_WEBVIEW_PORT;
  process.env.WRITING_ROOM_WEBVIEW_PORT = String(webviewPort);
  try {
    const options = { host: '127.0.0.1', port, strictPort: true };
    if (process.env.E2E_TARGET === 'preview') {
      return await preview({ preview: options, logLevel: 'silent' });
    }
    const server = await devServer({ server: options, logLevel: 'silent' });
    return await server.listen();
  } finally {
    if (old === undefined) {
      delete process.env.WRITING_ROOM_WEBVIEW_PORT;
    } else {
      process.env.WRITING_ROOM_WEBVIEW_PORT = old;
    }
  }
}

test('serves and reaches the shell on the forwarded port without exposing the app there', async () => {
  test.setTimeout(60_000);
  const temporary = mkdtempSync(join(tmpdir(), 'writing-room-forwarding-'));
  const key = join(temporary, 'key.pem');
  const cert = join(temporary, 'cert.pem');
  const appPort = await availablePort();
  let webviewPort = await availablePort();
  while (webviewPort === appPort) {
    webviewPort = await availablePort();
  }
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(temporary, { recursive: true, force: true })];
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
      '-subj', '/CN=forwarded.localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const app = await openApp(appPort, webviewPort);
    cleanup.unshift(() => app.close());
    const httpView = 'http://127.0.0.1:' + webviewPort;
    await expect.poll(async () => (await fetch(httpView + '/webview/service-worker.js')).status).toBe(200);
    for (const path of ['/', '/src/main.ts', '/webview/../index.html', '/webview/config.json']) {
      expect((await fetch(httpView + path)).status).toBe(404);
    }
    expect(await (await fetch('http://127.0.0.1:' + appPort + '/webview/config.json')).json())
      .toEqual({ appPort, webviewPort });

    const proxy = await openForwardingProxy(appPort, webviewPort,
      { key: readFileSync(key), cert: readFileSync(cert) }, Number(process.env.E2E_EXTENSIONS_PORT));
    cleanup.unshift(() => proxy.close());
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    cleanup.unshift(() => browser.close());
    const page = await browser.newPage();
    const appOrigin = 'https://' + appPort + '--forwarded.localhost:' + proxy.port;
    const viewOrigin = 'https://' + webviewPort + '--forwarded.localhost:' + proxy.port;
    const code = await bundleWebviewHarness();
    await openWebviewHarness(page, appOrigin, code);
    const fixtureOrigin = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT;
    await page.evaluate(root => {
      const harness = (window as any).harness;
      harness.set('<script src="' + harness.asWebviewUri(root + '/first.js')
        + '"></script><p>Forwarded content</p>', true, root);
    }, fixtureOrigin + '/webview');
    const shell = page.locator('iframe[title="Webview"]');
    expect(new URL((await shell.getAttribute('src'))!).origin).toBe(viewOrigin);
    const content = page.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]');
    await expect(content.getByText('Forwarded content')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).harness.messages.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).harness.send('round trip'))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).harness.messages.at(-1))).toBe('round trip');

    const workbench = await browser.newPage();
    const configs: string[] = [];
    workbench.context().on('request', request => {
      if (request.url() === appOrigin + '/webview/config.json') {
        configs.push(request.url());
      }
    });
    const extensionLocation = new URL('/__extension-fixtures/webview/', appOrigin).href;
    await seedInstalledExtensions(workbench, [{ location: extensionLocation, manifest }]);
    await workbench.goto(appOrigin);
    await workbench.keyboard.press('F1');
    await workbench.getByRole('combobox').fill('Fixture: Open Retained Webview');
    await workbench.getByRole('option', { name: 'Fixture: Open Retained Webview' }).click();
    const actualShell = workbench.locator('iframe[title="Webview"]');
    await expect(actualShell).toHaveAttribute('src', new RegExp('^' + viewOrigin.replaceAll('.', '\\.') + '/'), { timeout: 10_000 });
    const actualContent = workbench.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]');
    await expect(actualContent.locator('#output')).toHaveText(Array.from({ length: 100 }, (_, index) => index).join(','));
    expect(configs).toHaveLength(1);
    await workbench.close();

    await page.route('**/webview/config.json', route => route.fulfill({ status: 404, body: '' }));
    await openWebviewHarness(page, appOrigin, code);
    await expect(page.locator('.webview-element').getByRole('status')).toContainText('WRITING_ROOM_WEBVIEW_PORT');
    await expect(shell).toHaveCount(0);

    await page.unroute('**/webview/config.json');
    await page.route(viewOrigin + '/webview/index.html*', route => route.abort());
    await openWebviewHarness(page, appOrigin, code);
    await expect(page.locator('.webview-element').getByRole('status')).toContainText(
      'Open its address in a new tab', { timeout: 15_000 },
    );
    await expect(shell).toHaveCount(0);
  } finally {
    for (const close of cleanup) {
      await close();
    }
  }
});

test('fails startup for an occupied or identical secondary port', async () => {
  const port = await availablePort();
  await expect(openApp(port, port)).rejects.toThrow('distinct from the app port');
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('The occupied port has no TCP address');
    }
    await expect(openApp(port, address.port)).rejects.toThrow('WRITING_ROOM_WEBVIEW_PORT could not listen');
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});
