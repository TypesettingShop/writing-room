import { expect, test, type Page } from '@playwright/test';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { diagnostics, openSettings, settingsKey } from './configuration.helpers.js';
import { collectPageErrors } from './fixtures.js';
import { outputView } from './window-ui.helpers.js';

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
  // The contributions go after deactivate and the subscriptions, so the palette opened at once can still list it.
  await expectNoCommand(page, 'Run Runtime Lifecycle');
});

async function runRuntimeCommand(page: Page, title: string) {
  const input = await openCommandPalette(page);
  await input.fill(title);
  await page.getByRole('option', { name: title, exact: true }).click();
}

async function openRuntimeOutput(page: Page) {
  const output = outputView(page);
  if (!await output.tab.isVisible()) {
    await runRuntimeCommand(page, 'View: Toggle Panel Visibility');
  }
  await output.tab.click();
  return output;
}

function workerLogChannel(output: ReturnType<typeof outputView>) {
  return output.channels.getByRole('option', { name: 'Extension Host (Worker)', exact: true });
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

/** The palette lists what was contributed when it opened, and contributions go once the host has deactivated. */
async function expectNoCommand(page: Page, title: string) {
  await expect.poll(async () => {
    const input = await openCommandPalette(page);
    await input.fill(title);
    const count = await page.getByRole('option', { name: title, exact: true }).count();
    await input.press('Escape');
    return count;
  }).toBe(0);
}

test('lets a subscription use the API while an uninstalled extension disposes it', async ({ page }) => {
  await seedInstalledExtensions(page, [{
    location: extensionFixtureLocation('runtime') + 'cleanup/',
    manifest: {
      name: 'runtime-cleanup', publisher: 'test', version: '1.0.0', browser: './extension.js',
      contributes: { commands: [{ command: 'runtime.cleanup.ping', title: 'Ping Runtime Cleanup' }] },
    },
  }]);
  await page.goto('/');
  const errors = collectPageErrors(page);
  try {
    await runRuntimeCommand(page, 'Ping Runtime Cleanup');
    await expect(page.getByText('Runtime cleanup is active')).toBeVisible();
    const disposals: string[] = [];
    page.on('console', message => {
      if (message.text().startsWith('Runtime cleanup disposed')) {
        disposals.push(message.text());
      }
    });
    await runRuntimeCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /test.runtime-cleanup/ }).click();
    await expectNoCommand(page, 'Ping Runtime Cleanup');
    const output = await openRuntimeOutput(page);
    const logChannel = workerLogChannel(output);
    if (await logChannel.count()) {
      await logChannel.click();
      await expect(output.log).not.toContainText('Subscription disposal failed');
    }
    expect(disposals).toEqual([expect.stringMatching(/^Runtime cleanup disposed after reading \d+ workspace folders$/)]);
    expect(errors.errors).toEqual([]);
  } finally {
    errors.stop();
  }
});

test('keeps deactivation and subscription errors in the host log over uninstall and host restart', async ({ page }) => {
  await seedInstalledExtensions(page, [{
    location: extensionFixtureLocation('runtime') + 'cleanup-errors/',
    manifest: {
      name: 'runtime-cleanup-errors', publisher: 'test', version: '1.0.0', browser: './extension.js',
      contributes: { commands: [{ command: 'runtime.cleanupErrors.ping', title: 'Ping Runtime Cleanup Errors' }] },
    },
  }]);
  await page.goto('/');
  const errors = collectPageErrors(page);
  try {
    await runRuntimeCommand(page, 'Ping Runtime Cleanup Errors');
    await expect(page.getByText('Runtime cleanup error fixture is active')).toBeVisible();
    const lastSubscription = page.waitForEvent('console', {
      predicate: message => message.text() === 'Runtime cleanup error fixture disposed its last subscription',
    });
    await runRuntimeCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /test.runtime-cleanup-errors/ }).click();
    await lastSubscription;
    await expectNoCommand(page, 'Ping Runtime Cleanup Errors');
    await expect(outputView(page).panel).toBeHidden();

    const output = await openRuntimeOutput(page);
    await workerLogChannel(output).click();
    await expect(output.log).toContainText('[error] [test.runtime-cleanup-errors] Deactivation failed: Error: Fixture deactivate failure');
    await expect(output.log).toContainText('[error] [test.runtime-cleanup-errors] Subscription disposal failed: Error: illegal state - object is disposed');

    const oldWorker = page.workers()[0];
    const closed = oldWorker.waitForEvent('close');
    await runRuntimeCommand(page, 'Restart Extension Host');
    await closed;
    await expect(output.log).toContainText('[test.runtime-cleanup-errors] Subscription disposal failed:');
    expect(errors.errors).toEqual([]);
  } finally {
    errors.stop();
  }
});

test('removes the contributions of an uninstalled extension only after it is deactivated', async ({ page }) => {
  await seedInstalledExtensions(page, [{
    location: extensionFixtureLocation('runtime') + 'settings/',
    manifest: {
      name: 'runtime-settings', publisher: 'test', version: '1.0.0', browser: './extension.js',
      contributes: {
        commands: [{ command: 'runtime.settings.show', title: 'Show Runtime Settings' }],
        configuration: { properties: { 'runtimeRemoval.server.level': { type: 'string', default: 'off' } } },
      },
    },
  }]);
  await page.addInitScript(key => {
    if (!sessionStorage.getItem('runtime-settings-seeded')) {
      localStorage.setItem(key, '{\n  "runtimeRemoval.server.level": "verbose"\n}\n');
      sessionStorage.setItem('runtime-settings-seeded', 'true');
    }
  }, settingsKey);
  await page.goto('/');
  const errors = collectPageErrors(page);
  try {
    await runRuntimeCommand(page, 'Show Runtime Settings');
    await expect(page.getByText('Runtime settings level: verbose')).toBeVisible();
    await openSettings(page);
    await expect(diagnostics(page)).toHaveCount(0);

    // wr-eycu.4bd: the settings listener of a removed extension must not see its section disappear.
    await runRuntimeCommand(page, 'Uninstall Extension...');
    await page.getByRole('option', { name: /test.runtime-settings/ }).click();
    await expect(diagnostics(page)).not.toHaveCount(0);
    await expectNoCommand(page, 'Show Runtime Settings');
    expect(errors.errors).toEqual([]);
  } finally {
    errors.stop();
  }
});
