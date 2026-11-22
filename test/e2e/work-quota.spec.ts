import { runCommand } from './configuration.helpers.js';
import { part } from './explorer.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expectEditorText, groups, selectedTab, waitForStorage } from './files.helpers.js';
import { box, drag, expect, test } from './fixtures.js';

const workA = '12345678-abcd-4000-8000-123456789abc';
const workB = '23456789-abcd-4000-8000-123456789abc';

test('rejects origin-wide extension state growth and still restores the Work layout and untitled draft', async ({ page }) => {
  const location = extensionFixtureLocation('work-quota');
  await page.route(location + 'extension.js', route => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `
      const vscode = require('vscode');
      exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('fixture.growWorkState', async () => {
        try {
          await context.workspaceState.update('value', 'x');
        } catch (error) {
          vscode.window.showInformationMessage(error.message);
        }
      }));
    `,
  }));
  await seedInstalledExtensions(page, [{
    location,
    manifest: {
      name: 'work-quota', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' }, browser: './extension.js',
      activationEvents: ['onCommand:fixture.growWorkState'],
      contributes: { commands: [{ command: 'fixture.growWorkState', title: 'Grow Work State' }] },
    },
  }]);
  await page.goto('/');
  await page.evaluate(({ workA, workB }) => {
    const state = JSON.stringify({ value: 'x'.repeat(256 * 1024 - '{"value":""}'.length) });
    const root = 'writing-room:storage:';
    for (const namespace of ['0:', '1:', 'work:' + workA + ':1:', 'work:' + workB + ':1:']) {
      for (const owner of ['test.first', 'test.second']) {
        localStorage.setItem(root + namespace + 'extensions.state.' + owner, state);
      }
    }
  }, { workA, workB });
  await page.goto('/?work=' + workA);
  await waitForStorage(page);
  await runCommand(page, 'Grow Work State', /^Grow Work State$/);
  await expect(page.getByText('Extensions exceed the 2 MiB total state limit.', { exact: true })).toBeVisible();
  const stateKey = 'writing-room:storage:work:' + workA + ':1:extensions.state.fixture.work-quota';
  expect(await page.evaluate(key => localStorage.getItem(key), stateKey)).toBeNull();

  const sidebar = part(page, 'sidebar');
  const initial = await box(sidebar);
  await drag(page, initial.x + initial.width, 190, initial.x + 235, 190);
  await expect.poll(async () => (await box(sidebar)).width).toBe(235);

  await runCommand(page, 'New Untitled Text File', /^File: New Untitled Text File$/);
  const editor = page.getByRole('textbox', { name: 'Editor content' });
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type('A draft after the rejected state update');
  const group = groups(page).first();
  await expectEditorText(group, 'A draft after the rejected state update');

  await page.reload();
  await expect(selectedTab(group)).toHaveText('Untitled-1');
  await expectEditorText(group, 'A draft after the rejected state update');
  await expect.poll(async () => (await box(sidebar)).width).toBe(235);
});
