import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createVsix } from '../../src/platform/extensionManagement/test/common/vsixTestUtils.js';
import manifest from '../fixtures/extensions/webview/package.json' with { type: 'json' };
import { runCommand, savedRecords } from './packages.helpers.js';

test('an installed VSIX supplies its Webview script and exposes a Webview tab through the document API', async ({ page }) => {
  const bytes = createVsix({
    manifest,
    files: {
      'extension.js': readFileSync(new URL('../fixtures/extensions/webview/extension.js', import.meta.url)),
      'panel.js': readFileSync(new URL('../fixtures/extensions/webview/panel.js', import.meta.url)),
    },
  });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await runCommand(page, 'Install from VSIX', /Install from VSIX/);
  await (await chooser).setFiles({ name: 'webview.vsix', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.getByRole('option', { name: /^Install Webview Fixture/ }).click();
  await expect.poll(() => savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'writing-room-tests.webview', source: 'vsix',
  })]);

  await page.getByRole('button', { name: 'New Text File...' }).click();
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
  await runCommand(page, 'Fixture: Open Retained Webview', /^Fixture: Open Retained Webview$/);
  const output = page.frameLocator('iframe[title="Webview"]').frameLocator('iframe[title="Webview content"]').locator('#output');
  await expect(output).toHaveText(Array.from({ length: 100 }, (_, index) => index).join(','));

  await runCommand(page, 'Fixture: Inspect Webview Tab', /^Fixture: Inspect Webview Tab$/);
  await expect(output).toHaveText(JSON.stringify({
    isWebviewTab: true, viewType: 'fixture.retained', hasActiveTextEditor: false,
  }));
});
