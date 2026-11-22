import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ManuscriptNodeKind } from '../../src/platform/manuscript/common/manuscript.js';
import { runCommand } from './configuration.helpers.js';
import { openProblemsCommand, problemNames, problemsStatus } from './diagnostics.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { groups } from './files.helpers.js';
import { screenshotColors } from './fixtures.js';
import { savedRecords } from './packages.helpers.js';
import { installFromGallery, realPin, requireRealExtensions, routeFixtureGallery } from './real-extensions.helpers.js';
import { chooseTheme, colorVariable, kindClass, openWithThemingFixtures, rgb } from './themes.helpers.js';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Navigator acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const nodes = '/api/works/' + work.id + '/nodes';
  async function addNode(kind: ManuscriptNodeKind, title: string, expectedRevision: number, parentId: string | null = null): Promise<string> {
    const response = await request.post(nodes, { headers, data: { kind, title, parentId, expectedRevision } });
    expect(response.status()).toBe(201);
    return (await response.json()).node.id;
  }
  return { url: '/?work=' + work.id, nodes, headers, addNode };
}

const navigator = (page: Page) => page.getByRole('region', { name: 'Navigator', exact: true });
const tree = (page: Page) => navigator(page).getByRole('tree');
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const title = (page: Page) => tree(page).getByRole('textbox', { name: 'Title', exact: true });
const toolbar = (page: Page, name: string) => navigator(page).locator('header').getByRole('button', { name, exact: true });

async function create(page: Page, command: string, name: string): Promise<void> {
  await toolbar(page, command).click();
  await title(page).fill(name);
  await title(page).press('Enter');
  await expect(title(page)).toHaveCount(0);
}

test('shows Navigator only in a work and remembers folder, expansion and selection', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Explorer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manuscript', exact: true })).toHaveCount(0);

  const { url } = await createWork(request, baseURL!);
  await page.goto(url);
  await expect(navigator(page)).toBeVisible();
  await create(page, 'New Part', 'Opening');
  await create(page, 'New Chapter', 'First');
  await row(page, '1부 - Opening').click();
  await create(page, 'New Chapter', 'Second');
  await create(page, 'New Part', 'Ending');
  await create(page, 'New Chapter', 'Again');
  await expect(row(page, '1장 - Again')).toBeVisible();
  await expect(row(page, '2장 - Second').locator('.manuscript-twig')).toHaveText('└─');
  await expect(row(page, '1장 - First').locator('.manuscript-twig')).toHaveText('├─');

  await row(page, '2부 - Ending').getByRole('button', { name: 'Collapse' }).dblclick();
  await expect(row(page, '2부 - Ending')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'Parent Folder')).toHaveCount(0);
  await row(page, '1부 - Opening').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(row(page, '2부 - Ending')).toHaveCount(0);
  await row(page, '1장 - First').click();
  await tree(page).press('ArrowRight');
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-selected', 'true');
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await row(page, '1장 - First').getAttribute('id'))!);
  await tree(page).press('Enter');
  await expect(row(page, '2장 - Second')).toHaveCount(0);
  await row(page, 'Parent Folder').click();
  await expect(row(page, '2장 - Second')).toBeVisible();
  await tree(page).press('Backspace');
  await expect(row(page, '2부 - Ending')).toBeVisible();
});

test('aligns Navigator branches with their parent toggles and reaches document icons', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const partId = await work.addNode('part', '떠나는 길', 0);
  await work.addNode('document', '부 여는 글', 1, partId);
  const chapterId = await work.addNode('chapter', '첫 만남', 2, partId);
  await work.addNode('document', '역 앞에서', 3, chapterId);
  await work.addNode('chapter', '두 번째 약속', 4, partId);
  await work.addNode('document', '집필 노트', 5);

  await openWithThemingFixtures(page, ['color-theme/']);
  await page.goto(work.url);
  const part = row(page, '1부 - 떠나는 길');
  await part.getByRole('button', { name: 'Expand' }).click();
  const chapter = row(page, '1장 - 첫 만남');
  await chapter.getByRole('button', { name: 'Expand' }).click();
  const introduction = row(page, '부 여는 글');
  const scene = row(page, '역 앞에서');

  await expect(part).toHaveAttribute('aria-level', '1');
  await expect(chapter).toHaveAttribute('aria-level', '2');
  await expect(scene).toHaveAttribute('aria-level', '3');
  await expect(part.locator('.manuscript-twig > span')).toHaveCount(0);
  await expect(row(page, '집필 노트').locator('.manuscript-twig > span')).toHaveCount(0);

  async function toggleCenter(folder: Locator): Promise<number> {
    const { x, width } = (await folder.getByRole('button', { name: 'Collapse' }).boundingBox())!;
    return x + width / 2;
  }

  async function branch(item: Locator) {
    return item.evaluate(element => {
      const segment = element.querySelector('.manuscript-twig > :last-child')!;
      const vertical = getComputedStyle(segment, '::before');
      const horizontal = getComputedStyle(segment, '::after');
      const bounds = segment.getBoundingClientRect();
      const iconOrToggle = element.querySelector('.manuscript-toggle, .codicon-file')!.getBoundingClientRect();
      return {
        verticalX: bounds.left + parseFloat(vertical.left) + parseFloat(vertical.width) / 2,
        gap: iconOrToggle.left - (bounds.left + parseFloat(horizontal.left) + parseFloat(horizontal.width)),
      };
    });
  }

  /** The colors of every stroke a row's guides draw: pipes, tees and ends. */
  async function strokes(item: Locator): Promise<string[]> {
    return item.locator('.manuscript-twig > span').evaluateAll(segments => segments.flatMap(segment => ['::before', '::after']
      .map(pseudo => getComputedStyle(segment, pseudo))
      .filter(stroke => stroke.content !== 'none' && stroke.content !== 'normal')
      .map(stroke => stroke.backgroundColor)));
  }

  const partX = await toggleCenter(part);
  const chapterX = await toggleCenter(chapter);
  const chapterBranch = await branch(chapter);
  const introductionBranch = await branch(introduction);
  const sceneBranch = await branch(scene);
  const pipeX = await scene.locator('.manuscript-twig-pipe').evaluate(element => {
    const stroke = getComputedStyle(element, '::before');
    return element.getBoundingClientRect().left + parseFloat(stroke.left) + parseFloat(stroke.width) / 2;
  });

  expect.soft(Math.abs(chapterBranch.verticalX - partX), 'part to chapter').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(introductionBranch.verticalX - partX), 'part to document').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(sceneBranch.verticalX - chapterX), 'chapter to document').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(pipeX - partX), 'part branch continues past the first chapter').toBeLessThanOrEqual(1);
  expect(chapterBranch.gap, 'folder branch stops before its toggle').toBeGreaterThanOrEqual(0);
  for (const [name, gap] of [['part document', introductionBranch.gap], ['chapter document', sceneBranch.gap]] as const) {
    expect.soft(gap, `${name} branch stops before its icon`).toBeGreaterThanOrEqual(0);
    expect.soft(gap, `${name} branch reaches its icon`).toBeLessThanOrEqual(1);
  }

  for (const [theme, kind] of [
    ['Writing Room Light', 'vs'], ['Writing Room Dark', 'vs-dark'],
    ['Fixture Contrast', 'hc-black'], ['Fixture Contrast Light', 'hc-light'],
  ]) {
    await chooseTheme(page, theme);
    await expect.poll(() => kindClass(page)).toBe(kind);
    const color = rgb(await colorVariable(page, 'descriptionForeground'));
    // The chapter's tee (2 strokes) and the scene's pipe (1) and end (2).
    expect([...await strokes(chapter), ...await strokes(scene)]).toEqual(Array(5).fill(color));
  }
});

test('keeps inline rename local until Enter and refreshes after a revision conflict', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const added = await request.post(work.nodes, { headers: work.headers, data: { kind: 'part', parentId: null, title: 'Original', expectedRevision: 0 } });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  await page.goto(work.url);
  await row(page, '1부 - Original').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await tree(page).press('Backspace');
  await tree(page).press('F2');
  await title(page).fill('Do not save');
  await title(page).press('Backspace');
  await expect(title(page)).toHaveValue('Do not sav');
  await title(page).press('Escape');
  await expect(row(page, '1부 - Original')).toBeVisible();
  await tree(page).press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row(page, '1부 - Original')).toBeVisible();

  await row(page, '1부 - Original').click();
  await tree(page).press('F2');
  await title(page).fill('My title');
  expect((await request.patch(work.nodes + '/' + node.id, {
    headers: work.headers, data: { title: 'Other tab', expectedRevision: 1 },
  })).ok()).toBe(true);
  await title(page).press('Enter');
  await expect(page.getByText('The manuscript changed elsewhere. It has been reloaded.')).toBeVisible();
  await expect(row(page, '1부 - Other tab')).toBeVisible();
  await expect(title(page)).toHaveValue('My title');
  await title(page).press('Enter');
  await expect(row(page, '1부 - My title')).toBeVisible();
});

test('renders only the visible window of a 10,000-row manuscript tree', async ({ page, request, baseURL }) => {
  const { url } = await createWork(request, baseURL!);
  const count = 10_000;
  await page.route('**/api/works/*/tree', route => route.fulfill({
    json: {
      revision: 1,
      nodes: Array.from({ length: count }, (_, position) => ({
        id: '00000000-0000-0000-0000-' + position.toString(16).padStart(12, '0'),
        parentId: null, kind: 'document', title: 'Document ' + (position + 1), position,
        metadata: {}, createdAt: 1, updatedAt: 1,
      })),
    },
  }));
  await page.goto(url);
  await expect(row(page, 'Document 1')).toBeVisible();
  const viewport = await tree(page).evaluate(element => Math.ceil(element.clientHeight / 24));
  await tree(page).press('End');
  const last = row(page, 'Document ' + count);
  await expect(last).toBeVisible();
  await expect(tree(page)).toBeFocused();
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
  expect(await tree(page).getByRole('treeitem').count()).toBeLessThanOrEqual(viewport + 17);
  await expect(row(page, 'Document 1')).toHaveCount(0);
});

test('opens a document once and keeps the title and path current in its editor tab', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const part = await work.addNode('part', 'Opening', 0);
  const chapter = await work.addNode('chapter', 'First', 1, part);
  await work.addNode('document', 'Scene', 2, chapter);
  await work.addNode('document', 'Next scene', 3, chapter);
  await page.goto(work.url);
  await row(page, '1부 - Opening').getByRole('button', { name: 'Expand' }).click();
  await row(page, '1장 - First').getByRole('button', { name: 'Expand' }).click();
  await row(page, 'Scene').click();
  await expect(page.getByRole('tab', { name: 'Scene', exact: true })).toHaveCount(0);
  await tree(page).press('Enter');
  const tab = page.getByRole('tab', { name: 'Scene', exact: true });
  await expect(page.locator('.tab').filter({ has: tab })).toHaveAttribute('title', '1부 - Opening / 1장 - First / Scene');
  await row(page, 'Scene').dblclick();
  await expect(tab).toHaveCount(1);
  await row(page, '1장 - First').click();
  await tree(page).press('F2');
  await title(page).fill('Revised');
  await title(page).press('Enter');
  await expect(page.locator('.tab').filter({ has: tab })).toHaveAttribute('title', '1부 - Opening / 1장 - Revised / Scene');
  await row(page, '1장 - Revised').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open All Documents', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Next scene', exact: true })).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});

test('edits only the selected node title in Properties and preserves other metadata', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const first = await request.post(work.nodes, {
    headers: work.headers, data: { kind: 'part', title: 'First part', parentId: null, expectedRevision: 0 },
  });
  const { node } = await first.json();
  expect(first.status()).toBe(201);
  const changed = await request.patch(work.nodes + '/' + node.id, {
    headers: work.headers, data: { metadata: { future: { key: 'keep' } }, expectedRevision: 1 },
  });
  expect(changed.ok()).toBe(true);
  const second = await request.post(work.nodes, {
    headers: work.headers, data: { kind: 'part', title: 'Second part', parentId: null, expectedRevision: 2 },
  });
  expect(second.status()).toBe(201);

  await page.goto(work.url);
  const properties = page.getByRole('region', { name: 'Properties', exact: true });
  const field = properties.getByRole('textbox', { name: 'Title' });
  await expect(properties.getByText('Select one item in the Navigator.')).toBeVisible();
  await row(page, '1부 - First part').click();
  await field.fill('Discard this');
  await row(page, '2부 - Second part').click();
  await expect(field).toHaveValue('Second part');
  await expect(row(page, '1부 - First part')).toBeVisible();

  await row(page, '1부 - First part').click();
  await field.fill('<tag>');
  await field.press('Enter');
  await expect(row(page, '1부 - <tag>')).toBeVisible();
  await expect(properties.getByText('1부 - <tag>', { exact: true })).toBeVisible();
  expect(await properties.locator('tag').count()).toBe(0);
  const snapshot = await (await request.get(work.nodes.replace('/nodes', '/tree'))).json();
  expect(snapshot.nodes.find((item: { id: string }) => item.id === node.id).metadata).toEqual({ future: { key: 'keep' } });
  await row(page, '2부 - Second part').click({ modifiers: ['ControlOrMeta'] });
  await expect(properties.getByText('2 items selected.')).toBeVisible();
  await expect(field).toBeHidden();
});

test('reorders before and into a row and handles a stale drag revision', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.addNode('chapter', 'Folder', 0);
  const a = await work.addNode('document', 'A', 1);
  await work.addNode('document', 'B', 2);
  await page.goto(work.url);
  const rootTitles = () => tree(page).getByRole('treeitem').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
  await row(page, 'B').dragTo(row(page, 'A'), { targetPosition: { x: 80, y: 4 } });
  await expect.poll(rootTitles).toEqual(['1장 - Folder', 'B', 'A']);
  await expect(tree(page).locator('[data-manuscript-drop]')).toHaveCount(0);
  await row(page, 'B').click();
  await tree(page).press('Alt+ArrowDown');
  await expect.poll(rootTitles).toEqual(['1장 - Folder', 'A', 'B']);
  await row(page, 'B').dragTo(row(page, '1장 - Folder'), { targetPosition: { x: 80, y: 12 } });
  await expect.poll(rootTitles).toEqual(['1장 - Folder', 'B', 'A']);
  await expect(row(page, 'B')).toHaveAttribute('aria-level', '2');

  const treeUrl = work.nodes.replace('/nodes', '/tree');
  const { revision } = await (await request.get(treeUrl)).json();
  expect((await request.patch(work.nodes + '/' + a, {
    headers: work.headers, data: { title: 'Elsewhere', expectedRevision: revision },
  })).ok()).toBe(true);
  await row(page, 'A').dragTo(row(page, '1장 - Folder'), { targetPosition: { x: 80, y: 12 } });
  await expect(page.getByText('The manuscript changed elsewhere. It has been reloaded.')).toBeVisible();
  await expect.poll(rootTitles).toEqual(['1장 - Folder', 'B', 'Elsewhere']);
  await expect(row(page, 'Elsewhere')).toHaveAttribute('aria-level', '1');
  await expect(tree(page).locator('[data-manuscript-drop]')).toHaveCount(0);
});

for (const forcedColors of ['none', 'active'] as const) {
  test(`paints Navigator drop lines across both guides with forced colors ${forcedColors}`, async ({ page, request, baseURL }) => {
    const work = await createWork(request, baseURL!);
    const part = await work.addNode('part', 'Part', 0);
    const chapter = await work.addNode('chapter', 'Chapter', 1, part);
    await work.addNode('chapter', 'Next chapter', 2, part);
    await work.addNode('document', 'Target', 3, chapter);
    await work.addNode('document', 'Next document', 4, chapter);
    await work.addNode('document', 'Source', 5);
    await page.emulateMedia({ forcedColors });
    await page.goto(work.url);
    await row(page, '1부 - Part').getByRole('button', { name: 'Expand' }).click();
    await row(page, '1장 - Chapter').getByRole('button', { name: 'Expand' }).click();

    const source = row(page, 'Source');
    const target = row(page, 'Target');
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    // The target has a continuing ancestor pipe and its own tee, both intersecting the row edges.
    const guideXs = await target.locator('.manuscript-twig > span').evaluateAll(segments => segments.map(segment => {
      const stroke = getComputedStyle(segment, '::before');
      return Math.floor(segment.getBoundingClientRect().left + parseFloat(stroke.left) + parseFloat(stroke.width) / 2);
    }));
    expect(guideXs).toHaveLength(2);

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 3, { steps: 3 });
      for (const position of ['before', 'after'] as const) {
        const x = Math.floor(to.x + to.width / 2);
        const y = Math.floor(to.y + (position === 'before' ? 1 : to.height - 1));
        const bodyY = y + (position === 'before' ? 4 : -4);
        await page.mouse.move(x - 1, y);
        await page.mouse.move(x, y);
        await expect(target).toHaveAttribute('data-manuscript-drop', position);

        const screenshot = await page.screenshot({ scale: 'css' });
        const [line, background, guide, ...crossings] = await screenshotColors(page, screenshot, [
          { x, y }, { x, y: bodyY }, { x: guideXs[0], y: bodyY },
          ...guideXs.map(guideX => ({ x: guideX, y })),
        ]);
        expect.soft(guide, `${position} guide remains visible`).not.toBe(background);
        expect.soft(line, `${position} drop line stands out from the row`).not.toBe(background);
        expect.soft(crossings, `${position} drop line covers both guides`).toEqual([line, line]);
      }
    } finally {
      await page.mouse.up();
    }
    await expect(source).toHaveAttribute('aria-level', '3');
    await expect(tree(page).locator('[data-manuscript-drop]')).toHaveCount(0);
  });
}

async function dropOnGroup(page: Page, item: Locator, group: Locator, x: number, strip = false): Promise<void> {
  const source = (await item.boundingBox())!;
  const target = (await group.boundingBox())!;
  const tabs = (await group.getByRole('tablist').boundingBox())!;
  const bodyTop = tabs.y + tabs.height;
  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const to = {
    x: target.x + x * target.width,
    y: strip ? tabs.y + tabs.height / 2 : (bodyTop + target.y + target.height) / 2,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 3, { steps: 3 });
  await page.mouse.move(to.x - 1, to.y);
  await page.mouse.move(to.x, to.y);
  if (!strip) {
    await expect(group.locator('[data-editor-drop-position]')).toHaveAttribute(
      'data-editor-drop-position', x > 0.9 ? 'right' : 'center',
    );
  }
  await page.mouse.up();
  await expect(page.locator('[data-editor-drop-position]')).toHaveCount(0);
}

test('opens editor-area drops in the target group, splits at the edge and caps each operation at 50', async ({ page, request, baseURL }) => {
  test.setTimeout(60_000);
  const work = await createWork(request, baseURL!);
  const folder = await work.addNode('chapter', 'Bundle', 0);
  await work.addNode('document', 'Single', 1);
  for (let position = 0; position < 51; position++) {
    await work.addNode('document', 'Scene ' + (position + 1), position + 2, folder);
  }
  await page.goto(work.url);
  const first = groups(page).first();
  await dropOnGroup(page, row(page, 'Single'), first, 0.65, true);
  await expect(first.getByRole('tab', { name: 'Single', exact: true })).toHaveCount(0);
  await dropOnGroup(page, row(page, 'Single'), first, 0.5);
  await expect(first.getByRole('tab', { name: 'Single', exact: true })).toHaveCount(1);
  await dropOnGroup(page, row(page, 'Single'), first, 0.5);
  await expect(first.getByRole('tab', { name: 'Single', exact: true })).toHaveCount(1);

  await dropOnGroup(page, row(page, '1장 - Bundle'), first, 0.97);
  await expect(groups(page)).toHaveCount(2);
  const second = groups(page).filter({ has: page.getByRole('tab', { name: 'Scene 1', exact: true }) });
  await expect(second.getByRole('tab')).toHaveCount(50);
  const original = groups(page).filter({ has: page.getByRole('tab', { name: 'Single', exact: true }) });
  expect((await second.boundingBox())!.x).toBeGreaterThan((await original.boundingBox())!.x);
  const names = await second.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.querySelector('.tab-name')?.textContent));
  expect(names).toEqual(Array.from({ length: 50 }, (_, position) => 'Scene ' + (position + 1)));
  await expect(second.getByRole('tab', { name: 'Scene 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Opened 50 of 51 documents.')).toBeVisible();
});

test('exposes ordinary Markdown documents to extensions and keeps labels when switching to source mode', async ({ page, request, baseURL }) => {
  test.setTimeout(60_000);
  const work = await createWork(request, baseURL!);
  const added = await request.post(work.nodes, {
    headers: work.headers, data: { kind: 'document', title: 'Shared document', parentId: null, expectedRevision: 0 },
  });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  const docURL = work.nodes.replace('/nodes', '/documents/') + node.id;
  expect((await request.put(docURL, {
    headers: { ...work.headers, 'Content-Type': 'text/markdown' }, data: 'Draft probe',
  })).ok()).toBe(true);

  const location = extensionFixtureLocation('manuscript-document-api');
  const command = 'Probe Manuscript Document API';
  await page.route(location + 'extension.js', route => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: `
      const vscode = require('vscode');
      exports.activate = context => {
        const collection = vscode.languages.createDiagnosticCollection('manuscript-probe');
        context.subscriptions.push(collection,
          vscode.languages.registerHoverProvider({ scheme: 'manuscript', language: 'markdown' }, {
            provideHover: document => new vscode.Hover(document.getText().trim()),
          }),
          vscode.commands.registerCommand('fixture.manuscriptProbe', async () => {
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'manuscript');
            if (!document) throw new Error('The extension cannot see the open manuscript.');
            const range = new vscode.Range(0, 0, 0, 5);
            collection.set(document.uri, [new vscode.Diagnostic(range, 'Manuscript lint probe', vscode.DiagnosticSeverity.Warning)]);
            const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, range.start);
            await vscode.window.showInformationMessage(document.languageId + ' hover: ' + hovers[0]?.contents[0]?.value);
          }));
      };
    `,
  }));
  await seedInstalledExtensions(page, [{
    manifest: {
      name: 'manuscript-document-api', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' }, browser: './extension.js',
      activationEvents: ['onCommand:fixture.manuscriptProbe'],
      contributes: { commands: [{ command: 'fixture.manuscriptProbe', title: command }] },
    },
    location,
  }]);

  await page.goto(work.url);
  await row(page, 'Shared document').dblclick();
  await expect(page.getByRole('textbox', { name: 'Markdown editor' })).toContainText('Draft probe', { timeout: 20_000 });
  await runCommand(page, command, new RegExp('^' + command + '$'));
  await expect(page.getByText('markdown hover: Draft probe', { exact: true })).toBeVisible();
  await expect(problemsStatus(page, '0 errors, 1 warning')).toBeVisible();
  await runCommand(page, 'Toggle Source Mode', /Markdown: Toggle Source Mode/);
  await expect(page.getByRole('button', { name: 'Switch to WYSIWYG' })).toBeVisible();
  await expect(groups(page).first().locator('.view-lines')).toContainText('Draft probe', { timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'Shared document', exact: true })).toHaveCount(1);
});


test('lints an open manuscript with the signed markdownlint extension', async ({ page, request, baseURL }) => {
  requireRealExtensions();
  test.setTimeout(90_000);
  const pin = await realPin('DavidAnson.vscode-markdownlint');
  const work = await createWork(request, baseURL!);
  const added = await request.post(work.nodes, {
    headers: work.headers, data: { kind: 'document', title: 'Linted scene', parentId: null, expectedRevision: 0 },
  });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  const docURL = work.nodes.replace('/nodes', '/documents/') + node.id;
  const original = '# Scene\n\n##Bad heading\n';
  expect((await request.put(docURL, {
    headers: { ...work.headers, 'Content-Type': 'text/markdown' }, data: original,
  })).ok()).toBe(true);

  await routeFixtureGallery(page);
  await page.goto(work.url);
  await row(page, 'Linted scene').dblclick();
  await expect(page.getByRole('textbox', { name: 'Markdown editor' })).toContainText('##Bad heading', { timeout: 20_000 });

  await tree(page).focus();
  const confirmation = await installFromGallery(page, 'markdownlint', 'markdownlint', /^Uninstall markdownlint/);
  expect(confirmation).toContain('SHA-256: ' + pin.vsix.sha256);
  expect(confirmation).toContain(`Signature: verified (${pin.publicKey})`);
  expect(await savedRecords(page)).toEqual([expect.objectContaining({
    identifier: 'davidanson.vscode-markdownlint', version: '0.62.1', source: 'gallery', signature: 'verified',
    packageSha256: pin.vsix.sha256,
  })]);

  await runCommand(page, openProblemsCommand, /^View: Focus Problems/);
  const rule = expect.stringContaining('markdownlint(MD018)');
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).toContainEqual(rule);
  const toggleLint = () => runCommand(page, 'markdownlint: Toggle linting', /^markdownlint: Toggle linting on\/off/);
  await toggleLint();
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).not.toContainEqual(rule);
  await toggleLint();
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).toContainEqual(rule);
  await page.getByRole('button', { name: 'Close Linted scene', exact: true }).click();
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).not.toContainEqual(rule);
  await page.getByRole('button', { name: 'Manuscript', exact: true }).click();
  await row(page, 'Linted scene').dblclick();
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).toContainEqual(rule);

  await page.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  const group = groups(page).first();
  const source = group.locator('.view-lines');
  await expect(source).toContainText('##Bad heading');
  await expect(group.locator('.squiggly-warning').first()).toBeVisible();
  await source.locator('.view-line').filter({ hasText: '##Bad heading' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText(' ');
  await expect(source).toContainText(/##\sBad\sheading/);
  await expect.poll(() => problemNames(page), { timeout: 10_000 }).not.toContainEqual(rule);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await request.get(docURL, { headers: work.headers })).text()).toBe(original.replace('##Bad', '## Bad'));
  await page.getByRole('button', { name: 'Switch to WYSIWYG' }).click();
  await expect(page.getByRole('heading', { name: 'Bad heading', level: 2 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Linted scene', exact: true })).toHaveCount(1);
});
