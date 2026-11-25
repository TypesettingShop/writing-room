import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { WorldTree } from '../../src/platform/world/common/world.js';

async function worldWithItem(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Item card acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const api = '/api/works/' + work.id + '/world';
  const getTree = async (): Promise<WorldTree> => {
    const response = await request.get(api + '/tree');
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const categoryResponse = await request.post(api + '/nodes', {
    headers, data: { title: '장소', kind: 'category', parentId: null, expectedRevision: 0 },
  });
  expect(categoryResponse.status()).toBe(201);
  const { node: category, revision } = await categoryResponse.json();
  const patch = async (id: string, update: object, revision: number) => {
    const response = await request.patch(api + '/nodes/' + id, { headers, data: { ...update, expectedRevision: revision } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const fields = [
    { id: 'location', label: '위치', kind: 'text' },
    { id: 'notes', label: '풍경', kind: 'longText', section: '환경' },
    { id: 'type', label: '종류', kind: 'choice', options: ['바다', '강'] },
  ];
  const categoryUpdate = await patch(category.id, { fields }, revision);
  const itemResponse = await request.post(api + '/nodes', {
    headers, data: { title: '항구', kind: 'item', parentId: category.id, expectedRevision: categoryUpdate.revision },
  });
  expect(itemResponse.status()).toBe(201);
  const { node: item, revision: itemRevision } = await itemResponse.json();
  await patch(item.id, { values: { hidden: '보존', type: '옛 선택' } }, itemRevision);
  return {
    url: '/?work=' + work.id,
    fields,
    async item() {
      const node = (await getTree()).nodes.find(node => node.id === item.id);
      return node?.kind === 'item' ? node : undefined;
    },
    async patchItem(update: object) { await patch(item.id, update, (await getTree()).revision); },
    async patchCategory(update: object) { await patch(category.id, update, (await getTree()).revision); },
    async deleteItem() {
      const response = await request.delete(api + '/nodes/' + item.id + '?expectedRevision=' + (await getTree()).revision, { headers });
      expect(response.ok()).toBe(true);
    },
  };
}

const card = (page: Page) => page.getByRole('region', { name: 'Item card' });
const name = (page: Page) => card(page).getByRole('textbox', { name: 'Name' });
const notes = (page: Page) => card(page).getByRole('textbox', { name: '풍경' });
const location = (page: Page) => card(page).getByRole('textbox', { name: '위치' });

async function openItem(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'World', exact: true }).click();
  await page.getByRole('treeitem', { name: '장소', exact: true }).dblclick();
  await page.getByRole('treeitem', { name: '항구', exact: true }).dblclick();
  await expect(card(page)).toBeVisible();
}

test('saves on Ctrl+S, idle and focus out while preserving data outside the category fields', async ({ page, request, baseURL }) => {
  const work = await worldWithItem(request, baseURL!);
  await openItem(page, work.url);
  await expect(card(page).getByText('The original value does not match this field: 옛 선택', { exact: true })).toBeVisible();
  await location(page).fill('동쪽 해안');
  await location(page).press('ControlOrMeta+s');
  await expect.poll(async () => (await work.item())?.values.location).toBe('동쪽 해안');
  await notes(page).fill('잔잔한 바다');
  await expect.poll(async () => (await work.item())?.values.notes).toBe('잔잔한 바다');
  await name(page).fill('푸른 항구 ');
  await page.getByRole('treeitem', { name: '항구', exact: true }).click();
  await expect.poll(async () => (await work.item())?.title).toBe('푸른 항구');
  await expect(name(page)).toHaveValue('푸른 항구 ');
  await expect(page.getByRole('tab', { name: '푸른 항구' })).toBeVisible();
  expect((await work.item())?.values).toMatchObject({ hidden: '보존', type: '옛 선택' });
});

test('keeps Chromium Hangul preedit through idle and a changed category before explicit save', async ({ page, request, baseURL }) => {
  const work = await worldWithItem(request, baseURL!);
  await openItem(page, work.url);
  const input = notes(page);
  await input.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await expect(input).toHaveValue('한');
  await work.patchCategory({ fields: [...work.fields, { id: 'trade', label: '교역', kind: 'text' }] });
  await page.waitForTimeout(1150);
  expect((await work.item())?.values.notes).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.item())?.values.notes).toBe('한');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('한');
  await cdp.send('Input.imeSetComposition', { text: '한국', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '한국' });
  await expect(input).toHaveValue('한국');
  await expect(card(page).getByRole('textbox', { name: '교역' })).toBeVisible();
});

test('asks before replacing remote item changes and leaves a remotely deleted item read-only', async ({ page, request, baseURL }) => {
  const work = await worldWithItem(request, baseURL!);
  await openItem(page, work.url);
  await work.patchItem({ values: { notes: '원격 변경' } });
  await notes(page).fill('내 메모');
  await notes(page).press('ControlOrMeta+s');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('"항구" changed elsewhere.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Reload' }).click();
  await expect(notes(page)).toHaveValue('원격 변경');
  await work.deleteItem();
  await page.keyboard.press('F1');
  await page.getByRole('combobox', { name: 'Type a command' }).fill('World Refresh');
  await page.getByRole('option', { name: /^World: Refresh$/ }).click();
  await expect(card(page).getByText('Item deleted', { exact: true })).toBeVisible();
  await expect(notes(page)).not.toBeEditable();
  await expect(notes(page)).toHaveValue('원격 변경');
});
