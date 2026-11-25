import { expect, test } from '@playwright/test';

test('holds incomplete fields, saves valid fields automatically and refreshes open item cards', async ({ page, request, baseURL }) => {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Category fields acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const api = '/api/works/' + work.id + '/world';
  const categoryResponse = await request.post(api + '/nodes', {
    headers, data: { title: '장소', kind: 'category', parentId: null, expectedRevision: 0 },
  });
  expect(categoryResponse.status()).toBe(201);
  const { node: category } = await categoryResponse.json();
  const itemResponse = await request.post(api + '/nodes', {
    headers, data: { title: '항구', kind: 'item', parentId: category.id, expectedRevision: 1 },
  });
  expect(itemResponse.status()).toBe(201);
  const state = async () => {
    const response = await request.get(api + '/tree');
    return response.json();
  };

  await page.goto('/?work=' + work.id);
  await page.getByRole('button', { name: 'World', exact: true }).click();
  await page.getByRole('treeitem', { name: '장소', exact: true }).dblclick();
  await page.getByRole('treeitem', { name: '항구', exact: true }).dblclick();
  const card = page.getByRole('region', { name: 'Item card' });
  await card.getByRole('button', { name: 'Edit Category Fields' }).click();
  const pane = page.getByRole('region', { name: 'Category fields' });
  await expect(pane.getByRole('button', { name: 'Reset to Default Template' })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Add Field' }).click();
  const row = pane.locator('[data-template-field]');
  const label = row.getByRole('textbox', { name: 'Label', exact: true });
  await expect(label).toBeFocused();
  await expect(label).toHaveValue('');
  await expect(row.getByText('Enter a label.', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Not saved: 1 problem' })).toBeVisible();
  expect((await state()).revision).toBe(2);

  await label.fill('항구 유형 ');
  await expect.poll(async () => (await state()).nodes.find((node: { id: string }) => node.id === category.id).fields[0]?.label)
    .toBe('항구 유형');
  await expect(label).toHaveValue('항구 유형 ');
  await row.getByRole('combobox', { name: 'Kind' }).selectOption('Choice');
  await expect(row.getByText('Add at least one option.', { exact: true })).toBeVisible();
  expect((await state()).revision).toBe(3);
  await label.press('ControlOrMeta+s');
  const add = row.getByRole('button', { name: 'Add Option' });
  await expect(add).toBeFocused();
  await add.click();
  await row.getByRole('textbox', { name: 'Option 1' }).fill('무역항');
  await expect.poll(async () => (await state()).nodes.find((node: { id: string }) => node.id === category.id).fields[0]?.options)
    .toEqual(['무역항']);

  await page.getByRole('tab', { name: '항구', exact: true }).click();
  const choice = card.getByRole('combobox', { name: '항구 유형', exact: true });
  await choice.selectOption('무역항');
  await choice.press('ControlOrMeta+s');
  const fieldId = (await state()).nodes.find((node: { id: string }) => node.id === category.id).fields[0].id;
  await expect.poll(async () => (await state()).nodes.find((node: { kind: string }) => node.kind === 'item').values[fieldId]).toBe('무역항');

  await page.getByRole('tab', { name: '장소 Fields', exact: true }).click();
  await row.getByRole('button', { name: 'Delete Field' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/1 item has a value in this field/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete Field', exact: true }).click();
  await expect.poll(async () => (await state()).nodes.find((node: { id: string }) => node.id === category.id).fields.length).toBe(0);
  expect((await state()).nodes.find((node: { kind: string }) => node.kind === 'item').values[fieldId]).toBe('무역항');
});
