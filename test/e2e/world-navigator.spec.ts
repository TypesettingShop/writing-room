import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WorldTree } from '../../src/platform/world/common/world.js';
import { runCommand } from './configuration.helpers.js';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'World navigator acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  return { url: '/?work=' + work.id, api: '/api/works/' + work.id, headers };
}

const activity = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const tree = (page: Page) => page.getByRole('tree', { name: 'World Navigator' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const presets = (page: Page) => page.locator('.world-presets').getByRole('button');

test('opens World only in work windows and keeps a keyboard-selected preset after reload', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await expect(activity(page, 'Explorer')).toBeVisible();
  await expect(activity(page, 'World')).toHaveCount(0);
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('World Refresh');
  await expect(page.getByRole('option', { name: /World: Refresh/ })).toHaveCount(0);

  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  const icon = activity(page, 'World').locator('.codicon-world');
  await expect(icon).toBeVisible();
  await expect(icon).toHaveCSS('font-size', '24px');
  await activity(page, 'World').click();
  await expect(page.getByText('Choose a starting point for this world.')).toBeVisible();
  await expect(presets(page)).toHaveCount(7);
  const modern = page.getByRole('button', { name: /^현대/ });
  const fantasy = page.getByRole('button', { name: /^판타지/ });
  await modern.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(fantasy).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(row(page, '시간과 공간').locator('.codicon-world-category')).toBeVisible();
  await expect(row(page, '달력').locator('.codicon-world-calendar')).toBeVisible();
  await expect(tree(page)).toBeFocused();
  await expect(presets(page)).toHaveCount(0);

  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, '장소')).toHaveAttribute('aria-level', '2');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Parent Folder')).toHaveCount(0);

  await row(page, '사회와 문화').click();
  await tree(page).press('ArrowRight');
  await expect(row(page, '세력')).toBeVisible();
  await expect(row(page, '종족')).toBeVisible();
  await row(page, '핵심 규칙·시스템').click();
  await tree(page).press('ArrowRight');
  await expect(row(page, '마법 체계')).toBeVisible();
  await page.reload();
  await expect(row(page, '마법 체계')).toBeVisible();
  await runCommand(page, 'World Collapse All', /^World: Collapse All$/);
  await expect(row(page, '마법 체계')).toHaveCount(0);

  const response = await request.get(work.api + '/world/tree');
  const snapshot: WorldTree = await response.json();
  const category = snapshot.nodes.find(node => node.title === '장소')!;
  const item = await request.post(work.api + '/world/nodes', {
    headers: work.headers,
    data: { kind: 'item', title: '항구', parentId: category.id, expectedRevision: snapshot.revision },
  });
  expect(item.status()).toBe(201);
  await runCommand(page, 'World Refresh', /^World: Refresh$/);
  await row(page, '시간과 공간').dblclick();
  await row(page, '장소').dblclick();
  await expect(row(page, '항구').locator('.codicon-world-item')).toBeVisible();
});

test('a stale preset selection shows the other window’s saved world', async ({ page, context, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await tab.goto(work.url);
    await activity(tab, 'World').click();
    await expect(presets(tab)).toHaveCount(7);
  }

  await page.getByRole('button', { name: /^판타지/ }).click();
  await expect(row(page, '시간과 공간')).toBeVisible();
  await other.getByRole('button', { name: /^무협/ }).click();
  await expect(other.getByText('The world changed elsewhere. It has been reloaded.', { exact: true })).toBeVisible();
  await expect(row(other, '시간과 공간')).toBeVisible();
  await row(other, '핵심 규칙·시스템').click();
  await tree(other).press('ArrowRight');
  await expect(row(other, '마법 체계')).toBeVisible();
  await expect(row(other, '무공 체계')).toHaveCount(0);
  const response = await request.get(work.api + '/world/tree');
  const snapshot: WorldTree = await response.json();
  expect(snapshot.revision).toBe(1);
});

test('World, Manuscript and Characters reject one another’s drags', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const plan = await request.post(work.api + '/nodes', {
    headers: work.headers, data: { kind: 'part', title: 'Opening', parentId: null, expectedRevision: 0 },
  });
  expect(plan.status()).toBe(201);
  const cast = await request.post(work.api + '/characters/nodes', {
    headers: work.headers, data: { kind: 'folder', title: 'Cast', parentId: null, expectedRevision: 0 },
  });
  expect(cast.status()).toBe(201);
  await page.goto(work.url);
  await activity(page, 'World').click();
  await page.getByRole('button', { name: /^빈 세계/ }).click();
  await expect(row(page, '시간과 공간')).toBeVisible();
  await activity(page, 'World').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Panel' }).click();
  await expect(page.getByRole('tab', { name: 'World', exact: true })).toBeVisible();

  const category = row(page, '시간과 공간');
  const targets = [
    ['Manuscript', /Opening/],
    ['Characters', /Cast/],
  ] as const;
  const alerts = await page.getByRole('alert').allTextContents();
  for (const [name, label] of targets) {
    await activity(page, name).click();
    const target = page.getByRole('tree', { name: name + ' Navigator' }).getByRole('treeitem', { name: label });
    await expect(target).toBeVisible();
    await category.dragTo(target);
    await target.dragTo(category);
    await expect(page.locator('[data-world-drop], [data-characters-drop], [data-manuscript-drop]')).toHaveCount(0);
  }
  expect(await page.getByRole('alert').allTextContents()).toEqual(alerts);
  for (const path of ['/world/tree', '/characters/tree', '/tree']) {
    const response = await request.get(work.api + path);
    expect(response.ok()).toBe(true);
    expect((await response.json()).revision).toBe(1);
  }
});

test('creates sibling items with the keyboard and protects the calendar from deletion', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await activity(page, 'World').click();
  await page.getByRole('button', { name: /^빈 세계/ }).click();
  await expect(row(page, '달력')).toBeVisible();
  const toolbar = (name: string) => page.locator('.view-pane-header').getByRole('button', { name, exact: true });
  await expect(toolbar('New Category').locator('.codicon-world-category-add')).toBeVisible();
  await expect(toolbar('New Item').locator('.codicon-world-item-add')).toBeVisible();
  await expect(toolbar('New Item')).toBeDisabled();
  await runCommand(page, 'World New Item', /^World: New Item$/);
  await expect(page.getByText('Select a category first.', { exact: true })).toBeVisible();

  const edit = page.locator('.world-inline-editor input');
  await runCommand(page, 'World New Category', /^World: New Category$/);
  await expect(edit).toBeFocused();
  await edit.fill('항구들');
  await edit.press('Enter');
  await expect(row(page, '항구들')).toBeVisible();
  await expect(toolbar('New Item')).toBeEnabled();

  for (const name of ['푸른 항구', '붉은 항구']) {
    await runCommand(page, 'World New Item', /^World: New Item$/);
    await expect(edit).toBeFocused();
    await edit.fill(name);
    await edit.press('Enter');
    await expect(row(page, name)).toHaveAttribute('aria-level', '2');
  }
  await tree(page).press('Alt+ArrowUp');
  await expect(tree(page).getByRole('treeitem', { name: /항구$/ })).toHaveText([/붉은 항구/, /푸른 항구/]);

  await row(page, '달력').click();
  await tree(page).press('Delete');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await tree(page).press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await row(page, '항구들').click();
  await tree(page).press('Delete');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Delete "항구들" and 2 items in it?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).press('Enter');
  await expect(row(page, '항구들')).toHaveCount(0);
  await expect(row(page, '달력')).toBeVisible();
});

test('virtualizes a 10,000-row World tree when moving to its last row', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const count = 10_000;
  await page.route('**' + work.api + '/world/tree', route => route.fulfill({
    json: {
      revision: 1,
      nodes: Array.from({ length: count }, (_, position) => ({
        id: '00000000-0000-0000-0000-' + position.toString(16).padStart(12, '0'),
        parentId: null, kind: 'category', title: '분류 ' + (position + 1), position,
        fields: [], createdAt: 1, updatedAt: 1,
      })),
    },
  }));
  await page.goto(work.url);
  await activity(page, 'World').click();
  await expect(row(page, '분류 1')).toBeVisible();
  const viewportRows = await tree(page).evaluate(element => Math.ceil(element.clientHeight / 24));
  await tree(page).press('End');
  const last = row(page, '분류 ' + count);
  await expect(last).toBeVisible();
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
  expect(await tree(page).getByRole('treeitem').count()).toBeLessThanOrEqual(viewportRows + 17);
  await expect(row(page, '분류 1')).toHaveCount(0);
});
