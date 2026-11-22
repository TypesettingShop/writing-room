import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { runCommand } from './configuration.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { groups, selectedTab } from './files.helpers.js';

const openCommand = 'Open Manuscript Fixture';
export const markdown = (page: Page) => groups(page).first().getByRole('textbox', { name: 'Markdown editor' });

export async function openManuscript(page: Page, workId: string, nodeId: string): Promise<void> {
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

export async function append(page: Page, text: string): Promise<void> {
  await markdown(page).locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
}

export async function save(page: Page): Promise<void> {
  await markdown(page).focus();
  await page.keyboard.press('ControlOrMeta+s');
}

export async function createManuscript(request: APIRequestContext, baseURL: string, apiURL = baseURL) {
  const headers = { Origin: new URL(baseURL).origin };
  const created = await request.post(apiURL + '/api/works', { headers, data: { title: 'Storage acceptance work' } });
  expect(created.status()).toBe(201);
  const { work } = await created.json();
  const nodes = '/api/works/' + work.id + '/nodes';
  const added = await request.post(apiURL + nodes, {
    headers, data: { kind: 'document', parentId: null, title: 'Storage acceptance document', expectedRevision: 0 },
  });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  const documentPath = '/api/works/' + work.id + '/documents/' + node.id;
  expect((await request.put(apiURL + documentPath, {
    headers: { ...headers, 'Content-Type': 'text/markdown' }, data: 'Draft',
  })).ok()).toBe(true);
  return { workId: work.id as string, nodeId: node.id as string, documentPath };
}
