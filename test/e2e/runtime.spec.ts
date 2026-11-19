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
  await uninstall.fill('Uninstall Extension...');
  await uninstall.press('Enter');
  const deactivated = page.waitForEvent('console', { predicate: message => message.text() === 'Lifecycle deactivated: first' });
  await page.getByRole('option', { name: /test.runtime-first/ }).click();
  await deactivated;
  const after = await openCommandPalette(page);
  await after.fill('Run Runtime Lifecycle');
  await expect(page.getByText('Run Runtime Lifecycle', { exact: true })).toHaveCount(0);
});

async function runRuntimeCommand(page: Page, title: string) {
  const input = await openCommandPalette(page);
  await input.fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

const contextManifest = {
  name: 'runtime-context', publisher: 'test', version: '1.0.0', browser: './extension.js',
  contributes: { commands: [
    { command: 'runtime.store', title: 'Store Runtime State' },
    { command: 'runtime.restore', title: 'Restore Runtime State' },
    { command: 'runtime.inspect', title: 'Inspect Runtime Environment' },
  ] },
};

test('shares mementos across tabs and preserves them across reload while keeping secrets in the page', async ({ page, context }) => {
  await seedInstalledExtensions(page, [{
    manifest: contextManifest, location: extensionFixtureLocation('runtime') + 'context/',
  }]);
  await page.goto('/');
  const second = await context.newPage();
  await second.goto('/');
  await runRuntimeCommand(second, 'Restore Runtime State');
  await expect(second.getByText('Runtime state: empty, empty, false, no secret')).toBeVisible();

  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
  await runRuntimeCommand(page, 'Store Runtime State');
  await expect.poll(async () => ({
    visible: await page.getByText('Runtime stored. Copy isolated: true').isVisible(),
    errors,
  })).toEqual({ visible: true, errors: [] });
  await runRuntimeCommand(second, 'Restore Runtime State');
  await expect(second.getByText('Runtime state: 1, stored safely, true, no secret')).toBeVisible();

  await runRuntimeCommand(page, 'Restart Extension Host');
  await runRuntimeCommand(page, 'Restore Runtime State');
  await expect(page.getByText('Runtime state: 1, stored safely, true, secret')).toBeVisible();
  await page.reload();
  await runRuntimeCommand(page, 'Restore Runtime State');
  await expect(page.getByText('Runtime state: 1, stored safely, true, no secret')).toBeVisible();

  await runRuntimeCommand(page, 'Uninstall Extension...');
  await page.getByRole('option', { name: /test.runtime-context/ }).click();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key =>
    key.includes('extensions.state.test.runtime-context'),
  ))).toEqual([]);
});

test('exposes runtime context paths and resolves explicit activation exports', async ({ page }) => {
  const location = extensionFixtureLocation('runtime');
  await seedInstalledExtensions(page, [
    { manifest: contextManifest, location: location + 'context/' },
    { manifest: { name: 'runtime-export', publisher: 'test', version: '1.0.0', browser: './extension.js' },
      location: location + 'export/' },
  ]);
  await page.goto('/');
  await runRuntimeCommand(page, 'Inspect Runtime Environment');
  await expect(page.getByText(
    '1.148.0 | Writing Room | 2 | true | fixture exports | false | '
    + 'vscode-userdata:/User/workspaceStorage/writing-room/test.runtime-context | vscode-userdata:/User/globalStorage/test.runtime-context',
  )).toBeVisible();
});

for (const installedFrom of ['folder', 'package'] as const) {
  test(`localizes a manifest and runs its nested worker from a ${installedFrom}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('writing-room:storage:version', '2');
      localStorage.setItem('writing-room:storage:0:user.settings.json', '{"locale":"ko"}');
    });
    await page.goto('/');
    await runRuntimeCommand(page, 'Install Extension from Location...');
    const input = page.getByRole('textbox', { name: 'Install Extension from Location' });
    const base = extensionFixtureLocation('runtime');
    await input.fill(base + (installedFrom === 'folder' ? 'globals/' : 'globals.vsix'));
    await input.press('Enter');
    await page.getByRole('option', { name: /^Install Runtime Globals/ }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('writing-room:storage:0:extensions.user')))
      .toContain('test.runtime-globals');
    await page.reload();
    const command = page.getByRole('option', { name: '런타임 Worker 실행', exact: true });
    await expect.poll(async () => {
      const input = await openCommandPalette(page);
      await input.fill('런타임 Worker 실행');
      if (await command.isVisible()) {
        return true;
      }
      await input.press('Escape');
      return false;
    }).toBe(true);
    await command.click();
    await expect(page.getByText(
      'ko | Runtime 시작 | %title% | resource read | echo one,echo two | true | false | true | undefined | undefined | undefined | undefined | true',
    )).toBeVisible();
  });
}
