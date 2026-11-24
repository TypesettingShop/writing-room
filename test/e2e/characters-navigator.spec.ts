import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { characterTypes, type CharacterTree } from '../../src/platform/characters/common/characters.js';
import type { CreateCharacterNode } from '../../src/platform/characters/common/charactersStore.js';
import webviewManifest from '../fixtures/extensions/webview/package.json' with { type: 'json' };
import { runCommand } from './configuration.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { screenshotColors } from './fixtures.js';
import { chooseTheme, kindClass, openWithThemingFixtures } from './themes.helpers.js';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Character navigator acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const path = '/api/works/' + work.id;
  const characters = path + '/characters';
  let revision = 0;
  return {
    url: '/?work=' + work.id, headers, characters,
    async addCharacter(kind: CreateCharacterNode['kind'], title: string, parentId: string | null = null, type?: CreateCharacterNode['type']) {
      const response = await request.post(characters + '/nodes', { headers, data: { kind, title, parentId, type, expectedRevision: revision } });
      expect(response.status()).toBe(201);
      const result = await response.json();
      revision = result.revision;
      return result.node.id as string;
    },
    async characterTree(): Promise<CharacterTree> {
      const response = await request.get(characters + '/tree');
      expect(response.ok()).toBe(true);
      return response.json();
    },
    async addPart(title: string) {
      const response = await request.post(path + '/nodes', { headers, data: { kind: 'part', title, parentId: null, expectedRevision: 0 } });
      expect(response.status()).toBe(201);
    },
  };
}

const activity = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const tree = (page: Page) => page.getByRole('tree', { name: 'Characters Navigator' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });

test('opens Characters in a work and remembers its location independently of Manuscript', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await expect(activity(page, 'Explorer')).toBeVisible();
  await expect(activity(page, 'Characters')).toHaveCount(0);
  const work = await createWork(request, baseURL!);
  await work.addPart('Opening');
  const folder = await work.addCharacter('folder', 'Cast');
  const nested = await work.addCharacter('folder', 'Crew', folder);
  await work.addCharacter('character', 'Rin', nested, 'female');
  await work.addCharacter('character', 'Outside');
  await page.goto(work.url);
  const manuscript = page.getByRole('tree', { name: 'Manuscript Navigator' });
  await expect(manuscript).toBeVisible();
  await manuscript.getByRole('treeitem', { name: '1부 - Opening' }).dblclick();
  await expect(manuscript.getByRole('treeitem', { name: 'Parent Folder' })).toBeVisible();

  await expect(activity(page, 'Manuscript').locator('.codicon-book')).toBeVisible();
  const charactersIcon = activity(page, 'Characters').locator('.codicon-characters-group');
  await expect(charactersIcon).toBeVisible();
  await expect(charactersIcon).toHaveCSS('font-size', '24px');
  await expect(charactersIcon).toHaveCSS('--character-icon-mask', /^url\(/);

  await activity(page, 'Characters').click();
  await expect(page.getByRole('region', { name: 'Navigator', exact: true })).toHaveCount(1);
  await row(page, 'Cast').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(row(page, 'Outside')).toHaveCount(0);
  await row(page, 'Crew').click();
  await tree(page).press('ArrowRight');
  await expect(row(page, 'Crew')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'Rin')).toHaveAttribute('aria-level', '2');
  await expect(row(page, 'Rin').locator('.characters-twig')).toHaveText('└─');
  await expect(row(page, 'Rin')).toHaveAttribute('aria-description', 'Female');
  await tree(page).press('ArrowLeft');
  await expect(row(page, 'Rin')).toHaveCount(0);
  await tree(page).press('ArrowRight');
  await page.reload();
  await expect(row(page, 'Crew')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'Crew')).toHaveAttribute('aria-expanded', 'true');
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await row(page, 'Crew').getAttribute('id'))!);

  await tree(page).press('Enter');
  await expect(row(page, 'Rin')).toHaveAttribute('aria-level', '1');
  await row(page, 'Parent Folder').click();
  await expect(row(page, 'Crew')).toBeVisible();
  await tree(page).press('Backspace');
  await expect(row(page, 'Outside')).toBeVisible();
  await row(page, 'Cast').click();
  await tree(page).press('ControlOrMeta+ArrowDown');
  await tree(page).press('Space');
  await expect(row(page, 'Cast')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'Outside')).toHaveAttribute('aria-selected', 'true');

  await activity(page, 'Manuscript').click();
  await expect(manuscript.getByRole('treeitem', { name: 'Parent Folder' })).toBeVisible();
  await expect(manuscript.getByRole('treeitem', { name: '1부 - Opening' })).toHaveCount(0);
});

test('renders type masks in light, dark, high contrast and forced colors', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  for (const type of characterTypes) {
    await work.addCharacter('character', type, null, type);
  }
  await openWithThemingFixtures(page, ['color-theme/']);
  await page.goto(work.url);
  await activity(page, 'Characters').click();
  await row(page, 'female').click();

  async function expectPainted() {
    const points = await Promise.all(characterTypes.map(async type => {
      const item = row(page, type);
      const icon = item.locator('.codicon-character-' + type);
      await expect(icon).toBeVisible();
      const bounds = (await icon.boundingBox())!;
      const x = Math.round(bounds.x);
      const y = Math.round(bounds.y);
      const mask = Array.from({ length: 256 }, (_, offset) => ({ x: x + offset % 16, y: y + Math.floor(offset / 16) }));
      return [{ x: x - 2, y }, ...mask];
    }));
    const pixels = await screenshotColors(page, await page.screenshot({ scale: 'css' }), points.flat());
    for (let offset = 0; offset < pixels.length; offset += 257) {
      const background = pixels[offset];
      expect(pixels.slice(offset + 1, offset + 257).filter(pixel => pixel !== background).length).toBeGreaterThan(12);
    }
  }

  for (const [theme, kind] of [['Writing Room Light', 'vs'], ['Writing Room Dark', 'vs-dark'], ['Fixture Contrast', 'hc-black']]) {
    await chooseTheme(page, theme);
    await expect.poll(() => kindClass(page)).toBe(kind);
    await expectPainted();
  }
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' });
  await expectPainted();
});

test('moves selected rows in tree order and commits the destination displayed by the insertion line', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const cast = await work.addCharacter('folder', 'Cast');
  const nested = await work.addCharacter('folder', 'Nested', cast);
  const a = await work.addCharacter('character', 'A', cast);
  const other = await work.addCharacter('folder', 'Other');
  const child = await work.addCharacter('character', 'Child', other);
  const b = await work.addCharacter('character', 'B');
  const c = await work.addCharacter('character', 'C');
  await page.goto(work.url);
  await activity(page, 'Characters').click();
  await row(page, 'Cast').getByRole('button', { name: 'Expand' }).click();
  const siblings = async (parentId: string | null) => (await work.characterTree()).nodes
    .filter(node => node.parentId === parentId).sort((a, b) => a.position - b.position).map(node => node.id);

  // Select in reverse tree order. The moving first child must be skipped when resolving the insert-before ID.
  await row(page, 'C').click();
  await row(page, 'Nested').click({ modifiers: ['ControlOrMeta'] });
  const target = row(page, 'Cast');
  const bounds = (await target.boundingBox())!;
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const atBottom = { dataTransfer: transfer, clientY: bounds.y + 21 };
  await row(page, 'C').dispatchEvent('dragstart', { dataTransfer: transfer });
  await target.dispatchEvent('dragenter', atBottom);
  await expect(target).toHaveAttribute('data-characters-drop', 'after');
  // A native target can be released before its next dragover.
  await target.dispatchEvent('drop', atBottom);
  await transfer.dispose();
  await expect.poll(() => siblings(cast)).toEqual([nested, c, a]);
  await expect(tree(page).locator('[data-characters-drop]')).toHaveCount(0);

  await row(page, 'B').dragTo(row(page, 'A'), { targetPosition: { x: 95, y: 11 } });
  await expect.poll(() => siblings(cast)).toEqual([nested, c, b, a]);
  await row(page, 'B').dragTo(row(page, 'A'), { targetPosition: { x: 95, y: 18 } });
  await expect.poll(() => siblings(cast)).toEqual([nested, c, a, b]);

  const targetFolder = row(page, 'Nested');
  await row(page, 'Other').dragTo(targetFolder, { targetPosition: { x: 95, y: 12 } });
  await expect.poll(() => siblings(nested)).toEqual([other]);
  await expect.poll(() => siblings(other)).toEqual([child]);
  const before = await work.characterTree();
  const refused = await page.evaluateHandle(() => new DataTransfer());
  const nestedBounds = (await targetFolder.boundingBox())!;
  await row(page, 'Cast').dispatchEvent('dragstart', { dataTransfer: refused });
  await targetFolder.dispatchEvent('dragenter', { dataTransfer: refused, clientY: nestedBounds.y + 12 });
  expect(await refused.evaluate(transfer => transfer.dropEffect)).toBe('none');
  await expect(tree(page).locator('[data-characters-drop]')).toHaveCount(0);
  await row(page, 'Cast').dispatchEvent('dragend', { dataTransfer: refused });
  await refused.dispose();
  expect((await work.characterTree()).revision).toBe(before.revision);

  await row(page, 'Cast').dblclick();
  await row(page, 'B').dragTo(row(page, 'Parent Folder'), { targetPosition: { x: 95, y: 12 } });
  await expect.poll(() => siblings(null)).toEqual([cast, b]);
});

test('reorders with Alt+Arrow and refreshes after a stale drop without saving it', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const folder = await work.addCharacter('folder', 'Cast');
  const a = await work.addCharacter('character', 'A');
  const b = await work.addCharacter('character', 'B');
  await page.goto(work.url);
  await activity(page, 'Characters').click();
  const titles = () => tree(page).getByRole('treeitem').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
  await row(page, 'Cast').click();
  await tree(page).press('Alt+ArrowUp');
  expect((await work.characterTree()).revision).toBe(3);
  await row(page, 'B').click();
  await tree(page).press('Alt+ArrowUp');
  await expect.poll(titles).toEqual(['Cast', 'B', 'A']);
  await tree(page).press('Alt+ArrowDown');
  await expect.poll(titles).toEqual(['Cast', 'A', 'B']);

  const { revision } = await work.characterTree();
  const change = await request.patch(work.characters + '/nodes/' + a, {
    headers: work.headers, data: { title: 'Elsewhere', expectedRevision: revision },
  });
  expect(change.ok()).toBe(true);
  await row(page, 'B').dragTo(row(page, 'Cast'), { targetPosition: { x: 90, y: 12 } });
  await expect(page.getByText('The character tree changed elsewhere. It has been reloaded.')).toBeVisible();
  await expect.poll(titles).toEqual(['Cast', 'Elsewhere', 'B']);
  const current = await work.characterTree();
  expect(current.revision).toBe(revision + 1);
  expect(current.nodes.find(node => node.id === b)?.parentId).toBeNull();
  expect(current.nodes.find(node => node.id === folder)?.position).toBe(0);
  await expect(tree(page).locator('[data-characters-drop]')).toHaveCount(0);
});

test('rejects both cross-navigator drags and character drops on editor tabs', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.addPart('Opening');
  await work.addCharacter('folder', 'Cast');
  await work.addCharacter('character', 'Rin');
  await page.goto(work.url);
  await activity(page, 'Characters').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Panel' }).click();
  await expect(page.getByRole('tab', { name: 'Characters', exact: true })).toBeVisible();
  const part = page.getByRole('tree', { name: 'Manuscript Navigator' }).getByRole('treeitem', { name: '1부 - Opening' });
  const character = row(page, 'Rin');
  const editor = page.locator('[id="workbench.parts.editor"]');
  await expect(editor.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  const alertsBefore = await page.getByRole('alert').allTextContents();
  for (const [source, destination] of [[character, part], [part, character], [character, editor.getByRole('tablist')]]) {
    await source.dragTo(destination, { targetPosition: { x: 95, y: 12 } });
    await expect(page.locator('[data-characters-drop], [data-manuscript-drop]')).toHaveCount(0);
  }
  await expect(editor.getByRole('tab')).toHaveCount(1);
  await expect(editor.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  expect(await page.getByRole('alert').allTextContents()).toEqual(alertsBefore);
  expect((await work.characterTree()).revision).toBe(2);
  await expect(page.getByRole('tree', { name: 'Manuscript Navigator' }).getByRole('treeitem')).toHaveCount(1);
  // A later drag must work after the rejected drops ended.
  await row(page, 'Rin').dragTo(row(page, 'Cast'), { targetPosition: { x: 95, y: 12 } });
  await expect(row(page, 'Rin')).toHaveAttribute('aria-level', '2');
});

test('opens a character dropped over a webview iframe and clears the drag', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.addCharacter('folder', 'Cast');
  await work.addCharacter('character', 'Rin');
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('webview'), manifest: webviewManifest }]);
  await page.goto(work.url);
  await activity(page, 'Characters').click();
  await runCommand(page, 'Fixture: Open Retained Webview', /^Fixture: Open Retained Webview$/);
  const frame = page.locator('iframe[title="Webview"]:visible');
  await expect(frame).toBeVisible();

  await row(page, 'Rin').dragTo(frame);
  await expect(page.getByRole('tab', { name: 'Rin', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-editor-drop-position]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Fixture retained' }).click();
  await expect(frame).toHaveCSS('pointer-events', 'auto');
  await expect(tree(page).locator('[data-characters-drop]')).toHaveCount(0);
  expect((await work.characterTree()).revision).toBe(2);
  await row(page, 'Rin').dragTo(row(page, 'Cast'), { targetPosition: { x: 95, y: 12 } });
  await expect(row(page, 'Rin')).toHaveAttribute('aria-level', '2');
});

const inlineName = (page: Page) => tree(page).getByRole('textbox', { name: 'Title', exact: true });
const toolbar = (page: Page, name: string) =>
  page.getByRole('region', { name: 'Navigator', exact: true }).locator('header').getByRole('button', { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

test('paints the Characters activity and add icons across themes', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await openWithThemingFixtures(page, ['color-theme/']);
  await page.goto(work.url);
  for (const [name, icon] of [['New Part', 'new-folder'], ['New Chapter', 'folder'], ['New Document', 'new-file']]) {
    await expect(toolbar(page, name).locator('.codicon-' + icon)).toBeVisible();
  }

  await activity(page, 'Characters').click();
  const icons = [
    activity(page, 'Characters').locator('.codicon-characters-group'),
    toolbar(page, 'New Character').locator('.codicon-character-add'),
    toolbar(page, 'New Folder').locator('.codicon-characters-group-add'),
  ];

  async function expectPainted() {
    for (const icon of icons) {
      await expect(icon).toBeVisible();
      const { width, height } = (await icon.boundingBox())!;
      const columns = Math.floor(width);
      const points = Array.from({ length: columns * Math.floor(height) }, (_, offset) => ({
        x: offset % columns,
        y: Math.floor(offset / columns),
      }));
      const pixels = await screenshotColors(page, await icon.screenshot({ scale: 'css' }), points);
      const background = pixels[0];
      expect(pixels.filter(pixel => pixel !== background).length).toBeGreaterThan(12);
      expect(pixels.filter(pixel => pixel === background).length).toBeGreaterThan(12);
    }
  }

  for (const [theme, kind] of [['Writing Room Light', 'vs'], ['Writing Room Dark', 'vs-dark'], ['Fixture Contrast', 'hc-black']]) {
    await chooseTheme(page, theme);
    await expect.poll(() => kindClass(page)).toBe(kind);
    await expectPainted();
  }
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'light' });
  await expectPainted();
});

test('creates through the palette and toolbar and keeps Characters commands in work windows', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Characters New Character');
  await expect(page.getByRole('option', { name: /Characters:/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await expect(page.getByRole('tree', { name: 'Manuscript Navigator' })).toBeVisible();
  await runCommand(page, 'Characters New Folder', /^Characters: New Folder$/);
  await expect(inlineName(page)).toBeFocused();
  await inlineName(page).fill('Cast');
  await inlineName(page).press('Enter');
  await expect(row(page, 'Cast')).toBeVisible();

  await toolbar(page, 'New Character').click();
  await expect(inlineName(page)).toBeFocused();
  await inlineName(page).fill('Pip');
  await inlineName(page).press('Enter');
  await expect(row(page, 'Pip')).toHaveAttribute('aria-description', 'Unknown');
  const { nodes } = await work.characterTree();
  const cast = nodes.find(node => node.title === 'Cast');
  expect(nodes.find(node => node.title === 'Pip')).toMatchObject({ parentId: cast?.id, type: 'unknown' });
  await toolbar(page, 'Collapse All').click();
  await expect(row(page, 'Pip')).toHaveCount(0);
  await row(page, 'Cast').click({ button: 'right' });
  await menuItem(page, 'Enter Folder').click();
  await row(page, 'Pip').click({ button: 'right' });
  await menuItem(page, 'Rename...').click();
  await expect(inlineName(page)).toBeFocused();
  await inlineName(page).fill('Renamed');
  await inlineName(page).press('Enter');
  await expect(row(page, 'Renamed')).toBeVisible();
});

test('checks the current type and changes every selected character, including with a folder selected', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.addCharacter('folder', 'Cast');
  await work.addCharacter('character', 'Rin', null, 'unknown');
  await work.addCharacter('character', 'Pip', null, 'male');
  await work.addCharacter('character', 'Outside', null, 'animal');
  await page.goto(work.url);
  await activity(page, 'Characters').click();
  const typeOption = (name: string) => page.getByRole('menuitemradio', { name, exact: true });

  await row(page, 'Rin').click({ button: 'right' });
  await menuItem(page, 'Set Type').click();
  await expect(typeOption('Unknown')).toHaveAttribute('aria-checked', 'true');
  await typeOption('Female').click();
  await expect(row(page, 'Rin')).toHaveAttribute('aria-description', 'Female');
  await page.reload();
  await expect(row(page, 'Rin')).toHaveAttribute('aria-description', 'Female');

  await row(page, 'Rin').click();
  await row(page, 'Pip').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Cast').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Pip').click({ button: 'right' });
  await menuItem(page, 'Set Type').click();
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveCount(0);
  await typeOption('Animal').click();
  for (const name of ['Rin', 'Pip']) {
    await expect(row(page, name)).toHaveAttribute('aria-description', 'Animal');
  }
  const { nodes, revision } = await work.characterTree();
  expect(nodes.filter(node => node.kind === 'character').map(node => node.type)).toEqual(['animal', 'animal', 'animal']);
  expect(revision).toBe(7);

  await row(page, 'Pip').click({ button: 'right' });
  await menuItem(page, 'Set Type').click();
  await expect(typeOption('Animal')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await row(page, 'Cast').click();
  await row(page, 'Cast').click({ button: 'right' });
  await menuItem(page, 'Enter Folder').click();
  await expect(row(page, 'Parent Folder')).toBeVisible();
});

test('confirms recursive deletion, supports menu reordering, and keeps the navigator menus separate', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.addPart('Opening');
  const cast = await work.addCharacter('folder', 'Cast');
  const nested = await work.addCharacter('folder', 'Nested', cast);
  await work.addCharacter('character', 'Rin', cast);
  await work.addCharacter('character', 'Pip', nested);
  const outside = await work.addCharacter('character', 'Outside');
  await page.goto(work.url);
  await activity(page, 'Characters').click();

  await row(page, 'Outside').click({ button: 'right' });
  await menuItem(page, 'Move Up').click();
  const roots = async () => (await work.characterTree()).nodes.filter(node => node.parentId === null)
    .sort((a, b) => a.position - b.position).map(node => node.id);
  await expect.poll(roots).toEqual([outside, cast]);
  await row(page, 'Cast').click();
  await row(page, 'Cast').click({ button: 'right' });
  await expect(menuItem(page, 'Set Type')).toHaveCount(0);
  await expect(menuItem(page, 'Open All Documents')).toHaveCount(0);
  await menuItem(page, 'Delete').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Delete "Cast" and 2 characters in it?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(row(page, 'Cast')).toBeVisible();
  await tree(page).press('Delete');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Cast')).toHaveCount(0);
  expect((await work.characterTree()).nodes.map(node => node.id)).toEqual([outside]);

  await activity(page, 'Manuscript').click();
  const part = page.getByRole('tree', { name: 'Manuscript Navigator' }).getByRole('treeitem', { name: '1부 - Opening' });
  await part.click({ button: 'right' });
  await expect(menuItem(page, 'Open All Documents')).toBeVisible();
  await expect(menuItem(page, 'Set Type')).toHaveCount(0);
});
