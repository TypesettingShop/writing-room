import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { characterTypes, type CharacterTree } from '../../src/platform/characters/common/characters.js';
import type { CreateCharacterNode } from '../../src/platform/characters/common/charactersStore.js';
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
