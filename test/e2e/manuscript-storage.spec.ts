import { expect, test, type Page } from '@playwright/test';
import { runCommand } from './configuration.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { chooseOption, groups, selectedTab } from './files.helpers.js';

const openCommand = 'Open Manuscript Fixture';
const markdown = (page: Page) => groups(page).first().getByRole('textbox', { name: 'Markdown editor' });

async function openManuscript(page: Page, workId: string, nodeId: string): Promise<void> {
  const uri = 'manuscript://' + workId + '/' + nodeId + '.md';
  const location = extensionFixtureLocation('manuscript-opening');
  await page.route(location + 'extension.js', route => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `
      const vscode = require('vscode');
      exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('fixture.openManuscript',
        () => vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(${JSON.stringify(uri)}))));
    `,
  }));
  await seedInstalledExtensions(page, [{
    manifest: {
      name: 'manuscript-opening', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' }, browser: './extension.js',
      activationEvents: ['onCommand:fixture.openManuscript'],
      contributes: { commands: [{ command: 'fixture.openManuscript', title: openCommand }] },
    },
    location,
  }]);
  await page.goto('/?work=' + workId);
  await runCommand(page, openCommand, new RegExp('^' + openCommand + '$'));
}

async function append(page: Page, text: string): Promise<void> {
  await markdown(page).locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
}

async function save(page: Page): Promise<void> {
  await markdown(page).focus();
  await page.keyboard.press('ControlOrMeta+s');
}

test('restores a saved manuscript, keeps a conflicting draft and reports an unavailable server', async ({ page, baseURL, request }) => {
  const headers = { Origin: new URL(baseURL!).origin };
  const created = await request.post('/api/works', { headers, data: { title: 'Storage acceptance work' } });
  expect(created.status()).toBe(201);
  const { work } = await created.json();
  const nodes = '/api/works/' + work.id + '/nodes';
  const added = await request.post(nodes, {
    headers, data: { kind: 'document', parentId: null, title: 'Storage acceptance document', expectedRevision: 0 },
  });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  const doc = '/api/works/' + work.id + '/documents/' + node.id;
  expect((await request.put(doc, { headers: { ...headers, 'Content-Type': 'text/markdown' }, data: 'Draft' })).ok()).toBe(true);
  const stored = async () => (await (await request.get(doc)).text()).trimEnd();

  await openManuscript(page, work.id, node.id);
  await expect(markdown(page).locator('p')).toHaveText('Draft', { timeout: 20_000 });
  await append(page, ' saved');
  await save(page);
  await expect.poll(stored).toBe('Draft saved');
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('');

  await page.reload();
  await expect(markdown(page).locator('p')).toHaveText('Draft saved', { timeout: 20_000 });
  await append(page, ' mine');

  const other = await page.context().newPage();
  try {
    await openManuscript(other, work.id, node.id);
    await expect(markdown(other).locator('p')).toHaveText('Draft saved', { timeout: 20_000 });
    await append(other, ' theirs');
    await save(other);
    await expect.poll(stored).toBe('Draft saved theirs');
  } finally {
    await other.close();
  }

  await save(page);
  await expect(page.getByText(/The content of the file is newer/)).toBeVisible();
  await chooseOption(page, 'Cancel');
  await expect(markdown(page).locator('p')).toHaveText('Draft saved mine');
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
  expect(await stored()).toBe('Draft saved theirs');

  await page.route('**' + doc, route => route.abort('connectionrefused'));
  await save(page);
  await expect(page.getByText(/The manuscript server is unavailable/)).toBeVisible();
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
  expect(await stored()).toBe('Draft saved theirs');
});

test('shows a persistent warning for the explicit in-memory store', async ({ page }) => {
  await page.goto('/?store=memory');
  await expect(page.getByText('In-memory store: changes are lost on reload.', { exact: true })).toBeVisible();
});
