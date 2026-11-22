import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import type {} from '../harness/files.js';
import { collectPageErrors, expect, test } from './fixtures.js';
import { startWithMarkdownSource } from './configuration.helpers.js';

test.beforeEach(async ({ page }) => {
  await startWithMarkdownSource(page);
});

const harness = '/test/harness/files.html';
let previewHarness: { html: string; code: string } | undefined;

if (process.env.E2E_TARGET === 'preview') {
  test.beforeAll(async () => {
    const result = await build({
      configFile: false,
      logLevel: 'error',
      build: {
        write: false,
        lib: { entry: fileURLToPath(new URL('../harness/files.ts', import.meta.url)), formats: ['es'] },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    const module = 'output' in output ? output.output.find(entry => entry.type === 'chunk') : undefined;
    if (!module) {
      throw new Error('Could not build the files test harness');
    }
    previewHarness = {
      code: module.code,
      html: await readFile(new URL('../harness/files.html', import.meta.url), 'utf8'),
    };
  });
}

async function openHarness(page: Page): Promise<void> {
  if (previewHarness) {
    const { html, code } = previewHarness;
    // Keep the test harness out of the production build while running it on the preview origin.
    await page.route('**' + harness, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/test/harness/files.ts', route => route.fulfill({ contentType: 'text/javascript', body: code }));
  }
  expect((await page.goto(harness))?.ok()).toBe(true);
  await expect(page.getByRole('status')).toHaveText('Ready');
}

test('persists files and empty folders after reload', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(async () => {
    await window.filesHarness.mkdir('empty');
    await window.filesHarness.write('한 글#?%.md', 'persistent text');
  });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(await page.evaluate(() => window.filesHarness.list(''))).toEqual(['empty', '한 글#?%.md']);
  expect(await page.evaluate(() => window.filesHarness.list('empty'))).toEqual([]);
  expect(await page.evaluate(() => window.filesHarness.read('한 글#?%.md')))
    .toMatchObject({ text: 'persistent text' });
});

test('initializes two tabs concurrently, broadcasts committed changes and rejects a stale write', async ({ page, context }) => {
  const other = await context.newPage();
  const otherErrors = collectPageErrors(other);
  try {
    await Promise.all([openHarness(page), openHarness(other)]);
    await page.evaluate(() => window.filesHarness.write('shared.md', 'old'));
    await expect.poll(() => other.evaluate(() => window.filesHarness.events))
      .toContain('ADDED:/workspace/shared.md');
    const reads = await Promise.all([page, other].map(tab => tab.evaluate(() => window.filesHarness.read('shared.md'))));
    expect(reads[0]).toEqual(reads[1]);
    const writes = await Promise.all([page, other].map((tab, i) =>
      tab.evaluate(({ i, etag }) => window.filesHarness.write('shared.md', String(i), etag), { i, etag: reads[i].etag })));
    expect([...writes].sort()).toEqual(['FILE_MODIFIED_SINCE', 'saved']);
    const loser = writes[0] === 'saved' ? other : page;
    await expect.poll(() => loser.evaluate(() => window.filesHarness.events))
      .toContain('UPDATED:/workspace/shared.md');
    expect(await loser.evaluate(() => window.filesHarness.read('shared.md')))
      .toMatchObject({ text: String(writes.indexOf('saved')) });
    expect(otherErrors.errors).toEqual([]);
  } finally {
    otherErrors.stop();
    await other.close();
  }
});

test('keeps fallback writes for the current page if the browser denies database access', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', message => { if (message.type() === 'warning') { warnings.push(message.text()); } });
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('Test blocked storage', 'SecurityError'); };
  });
  await openHarness(page);
  await page.evaluate(() => window.filesHarness.write('memory.md', 'session only'));
  expect(await page.evaluate(() => window.filesHarness.read('memory.md'))).toMatchObject({ text: 'session only' });
  expect(warnings.filter(message => message.includes('Workbench file storage switched to memory'))).toHaveLength(1);

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(await page.evaluate(() => window.filesHarness.list(''))).toEqual([]);
});

declare global {
  interface Window {
    filesTestConnection?: IDBDatabase;
  }
}

test('the workbench prepares its real workspace while the welcome editor mounts', async ({ page }) => {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      const request = open.call(this, name, version);
      if (name === 'writing-room-files') {
        request.addEventListener('success', () => { window.filesTestConnection = request.result; }, { once: true });
      }
      return request;
    };
  });
  expect((await page.goto('/'))?.ok()).toBe(true);
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const connection = window.filesTestConnection;
    if (connection) {
      return new Promise<unknown>((resolve, reject) => {
        const request = connection.transaction('vscode-vfs').objectStore('vscode-vfs').get('/workspace');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
  })).toMatchObject({ type: 2, size: 0 });
});

test('mounts the workbench without waiting for file storage to open', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      document.documentElement.dataset.fileStorageOpening = 'true';
      return new EventTarget() as IDBOpenDBRequest;
    };
  });
  expect((await page.goto('/'))?.ok()).toBe(true);
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-file-storage-opening', 'true');
});

test('opens the workbench and warns once when its file storage is blocked', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('Workbench file storage switched to memory')) {
      warnings.push(message.text());
    }
  });
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException('Test blocked storage', 'SecurityError'); };
  });
  expect((await page.goto('/'))?.ok()).toBe(true);
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('Files are kept for this session only');
});
