import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { CharacterTree } from '../../src/platform/characters/common/characters.js';
import type { CreateCharacterNode } from '../../src/platform/characters/common/charactersStore.js';
import { runCommand } from './configuration.helpers.js';
import { groups } from './files.helpers.js';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Character cards' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const characters = '/api/works/' + work.id + '/characters';
  async function tree(): Promise<CharacterTree> {
    const response = await request.get(characters + '/tree');
    expect(response.ok()).toBe(true);
    return response.json();
  }
  return {
    url: '/?work=' + work.id, characters, headers, tree,
    async add(title: string, kind: CreateCharacterNode['kind'] = 'character', parentId: string | null = null) {
      const response = await request.post(characters + '/nodes', {
        headers, data: { title, kind, parentId, expectedRevision: (await tree()).revision },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).node.id as string;
    },
  };
}

const navigator = (page: Page) => page.getByRole('tree', { name: 'Characters Navigator' });
const row = (page: Page, name: string) => navigator(page).getByRole('treeitem', { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const menu = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function showCharacters(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
}

test('opens cards from the navigator, reuses existing tabs, and tracks their names and icons', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const folder = await work.add('Cast', 'folder');
  await work.add('Rin', 'character', folder);
  await work.add('Kai', 'character', folder);
  await showCharacters(page, work.url);

  await row(page, 'Cast').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(tab(page, 'Cast')).toHaveCount(0);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');
  await row(page, 'Rin').click();
  await navigator(page).press('Enter');
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await row(page, 'Kai').click({ button: 'right' });
  await menu(page, 'Open').click();
  await expect(tab(page, 'Kai')).toHaveAttribute('aria-selected', 'true');
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  await expect(groups(page)).toHaveCount(2);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');

  await row(page, 'Rin').click();
  await navigator(page).press('F2');
  const rename = navigator(page).getByRole('textbox', { name: 'Title' });
  await rename.fill('Rin Updated');
  await rename.press('Enter');
  await expect(tab(page, 'Rin Updated')).toBeVisible();
  await row(page, 'Rin Updated').click({ button: 'right' });
  await menu(page, 'Set Type').click();
  await page.getByRole('menuitemradio', { name: 'Female', exact: true }).click();
  await expect(page.locator('.tab').filter({ has: tab(page, 'Rin Updated') }).locator('.codicon-character-female')).toBeVisible();

  await navigator(page).press('Backspace');
  await row(page, 'Cast').click();
  await navigator(page).press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tab(page, 'Rin Updated')).toHaveCount(0);
  await expect(tab(page, 'Kai')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps a character deleted elsewhere open and marks it deleted on refresh', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toBeVisible();
  const response = await request.delete(work.characters + '/nodes/' + id + '?expectedRevision=' + (await work.tree()).revision, {
    headers: work.headers,
  });
  expect(response.ok()).toBe(true);
  await page.getByRole('region', { name: 'Navigator', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Character deleted', { exact: false })).toBeVisible();
  await expect(tab(page, 'Rin')).toBeVisible();
});
