import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import manifest from '../fixtures/extensions/webview/restore/package.json' with { type: 'json' };

const stateKey = 'writing-room:storage:1:webview.states.v1';
const editorKey = 'writing-room:storage:1:memento/workbench.parts.editor';
const fixtureBase = () => new URL('restore/', extensionFixtureLocation('webview')).href;

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

const content = (page: Page) =>
  page.frameLocator('iframe[title="Webview"]:visible').frameLocator('iframe[title="Webview content"]');

function extensionWorkers(page: Page) {
  return page.workers().filter(worker => /\/extensionHostWorkerMain(?:[.-])/.test(new URL(worker.url()).pathname));
}

async function saveLayout(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
}

test.beforeEach(async ({ page }) => {
  await seedInstalledExtensions(page, [{ location: fixtureBase(), manifest }]);
});

test('restores the pane position and JSON state, rejecting oversize updates', async ({ page }) => {
  await page.goto('/');
  const warnings: string[] = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('Webview state could not be saved')) {
      warnings.push(message.text());
    }
  });
  await command(page, 'Fixture: Open Restorable Webview');
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).toContain('count');
  await content(page).getByRole('button', { name: 'Save Oversize State' }).click({ clickCount: 2 });
  await expect.poll(() => warnings.length).toBe(1);
  expect(await page.evaluate(key => localStorage.getItem(key), stateKey)).not.toContain('999');
  await saveLayout(page);
  const serialized = await page.evaluate(key => localStorage.getItem(key), editorKey);
  expect(serialized).toContain('Restorable');
  expect(serialized).not.toContain('Increment');

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toBeVisible();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  await expect(content(page).locator('#counter')).toHaveText('2');
  await expect(content(page).locator('#serializer')).toHaveText('2');
  await expect(page.locator('.editor-group-container').first().getByRole('tab')).toHaveText(['Welcome', 'Restorable']);
});

test('keeps hidden restores lazy and isolates a serializer failure', async ({ page }) => {
  await page.goto('/');
  await command(page, 'Fixture: Open Restorable Webview');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await page.getByRole('tab', { name: 'Welcome' }).click();
  await saveLayout(page);
  const entryRequests: string[] = [];
  page.context().on('request', request => {
    if (request.url() === fixtureBase() + 'extension.js') {
      entryRequests.push(request.url());
    }
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toBeVisible();
  expect(entryRequests).toEqual([]);
  await page.getByRole('tab', { name: 'Restorable' }).click();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  expect(entryRequests).toHaveLength(1);

  await command(page, 'Fixture: Open Failing Restore');
  await expect(page.getByRole('tab', { name: 'Failing Restore' })).toBeVisible();
  await expect(page.locator('.editor-group-container')).toHaveCount(2);
  await saveLayout(page);
  await page.reload();
  await expect(page.getByText('The extension could not restore this Webview.')).toBeVisible();
  await expect(content(page).getByText('Restored 1')).toBeVisible();
});

test('ignores late success for a closed tab and restores eligible tabs after host restart', async ({ page }) => {
  await page.goto('/');
  await command(page, 'Fixture: Open Late Restore');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await saveLayout(page);
  await page.reload();
  await expect(content(page).getByText('Waiting for release')).toBeVisible();
  await page.getByRole('button', { name: 'Close Late Restore' }).click();
  await command(page, 'Fixture: Open Restorable Webview');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await command(page, 'Fixture: Release Late Restore');
  await expect(content(page).getByText('Opened')).toBeVisible();
  await expect(content(page).getByText('Late completion')).toHaveCount(0);

  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect(content(page).locator('#counter')).toHaveText('1');
  await command(page, 'Restart Extension Host');
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  await expect(content(page).locator('#counter')).toHaveText('1');
});

test('disposes panels in the old worker and restores only the serializable tab with a new handle', async ({ page }) => {
  const lifecycle: string[] = [];
  const closedHandles: string[] = [];
  const restoredHandles: string[] = [];
  page.on('console', message => {
    const text = message.text();
    const disposed = 'Webview fixture disposed: ';
    const closed = 'Webview fixture close handle: ';
    const restored = 'Webview fixture restore handle: ';
    if (text.startsWith(disposed)) {
      lifecycle.push(text.slice(disposed.length));
    } else if (text === 'Webview fixture deactivated') {
      lifecycle.push('deactivated');
    } else if (text.startsWith(closed)) {
      closedHandles.push(text.slice(closed.length));
    } else if (text.startsWith(restored)) {
      restoredHandles.push(text.slice(restored.length));
    }
  });
  await page.addInitScript(() => {
    if (window.top !== window) {
      return;
    }
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message) {
      if (message?.kind === 'request' && message.proxy === 'ExtHostWebviews') {
        if (message.method === '$onPanelDisposed') {
          console.debug('Webview fixture close handle:', message.args[1]);
        } else if (message.method === '$deserializePanel') {
          console.debug('Webview fixture restore handle:', message.args[1]);
        }
      }
      Reflect.apply(send, this, arguments);
    };
  });
  await page.goto('/');

  await command(page, 'Fixture: Open Restorable Webview');
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).toContain('count');
  await command(page, 'Fixture: Open Transient Webview');
  await expect(page.locator('.editor-group-container').nth(1).getByRole('tab', { name: 'Transient' })).toBeVisible();

  const closed = extensionWorkers(page)[0].waitForEvent('close');
  await command(page, 'Restart Extension Host');
  await closed;
  await expect(page.getByRole('tab', { name: 'Transient' })).toHaveCount(0);
  const firstGroup = page.locator('.editor-group-container').first();
  await expect(firstGroup.getByRole('tab')).toHaveText(['Welcome', 'Restorable']);
  await expect(content(page).getByText('Restored 1')).toBeVisible();
  await expect(content(page).locator('#serializer')).toHaveText('1');
  expect(lifecycle.slice(0, -1).sort()).toEqual(['Restorable', 'Transient']);
  expect(lifecycle.at(-1)).toBe('deactivated');
  expect(closedHandles).toHaveLength(2);
  expect(restoredHandles).toHaveLength(1);
  expect(closedHandles).not.toContain(restoredHandles[0]);
});

test('terminates a worker that stops responding during restart cleanup', async ({ page }) => {
  await page.goto('/');
  const armed = page.waitForEvent('console', message => message.text() === 'Webview fixture armed shutdown block');
  await command(page, 'Fixture: Block Webview Host Shutdown');
  await armed;
  const oldWorker = extensionWorkers(page)[0];
  const closed = oldWorker.waitForEvent('close', { timeout: 8_000 });
  const blocked = page.waitForEvent('console', {
    predicate: message => message.text() === 'Webview fixture blocked shutdown',
    timeout: 8_000,
  });
  await command(page, 'Restart Extension Host');
  await Promise.all([blocked, closed]);
  await command(page, 'Fixture: Open Restorable Webview');
  await expect(content(page).getByText('Opened')).toBeVisible();
  expect(extensionWorkers(page)).toHaveLength(1);
  expect(extensionWorkers(page)[0]).not.toBe(oldWorker);
});

test('keeps a missing extension tab closable and deletes its stored state', async ({ page }) => {
  await page.goto('/');
  await command(page, 'Fixture: Open Restorable Webview');
  await content(page).getByRole('button', { name: 'Increment' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).toContain('count');
  await saveLayout(page);
  await page.addInitScript(() => {
    if (window.top === window) {
      localStorage.removeItem('writing-room:storage:0:extensions.user');
    }
  });
  await page.reload();
  await expect(page.getByText('The extension that provides this Webview is unavailable.')).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), stateKey)).not.toContain('webview-restore');
  await page.getByRole('button', { name: 'Close Restorable' }).click();
  await expect(page.getByRole('tab', { name: 'Restorable' })).toHaveCount(0);
});
