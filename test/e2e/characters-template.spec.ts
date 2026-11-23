import { expect, test, type Page } from '@playwright/test';
import { getDefaultCharacterTemplate } from '../../src/platform/characters/common/defaultCharacterTemplate.js';
import { runCommand } from './configuration.helpers.js';

const templateCommand = (page: Page) => runCommand(page, 'Edit Field Template', /^Characters: Edit Field Template$/);
const templateTab = (page: Page) => page.getByRole('tab', { name: 'Field Template', exact: true });

test('opens the saved field template from the palette and toolbar, reuses its group and restores the tab', async ({ page, request, baseURL }) => {
  const response = await request.post('/api/works', {
    headers: { Origin: new URL(baseURL!).origin }, data: { title: 'Field template acceptance' },
  });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  await page.goto('/?work=' + work.id);

  await templateCommand(page);
  await expect(templateTab(page)).toHaveAttribute('aria-selected', 'true');
  const fields = page.getByRole('list', { name: 'Template fields' }).getByRole('listitem');
  await expect(fields).toHaveCount(8);
  for (const [index, field] of getDefaultCharacterTemplate().entries()) {
    await expect(fields.nth(index).getByText(field.label, { exact: true })).toBeVisible();
  }

  const groups = page.locator('[data-group-id]');
  const left = groups.first();
  await left.getByRole('button', { name: 'Split Editor Right' }).click();
  const right = groups.nth(1);
  await right.getByRole('button', { name: 'Close Field Template' }).click();
  await expect(groups).toHaveCount(1);
  await left.getByRole('tab', { name: 'Welcome' }).click();
  await left.getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(right).toHaveClass(/\bactive\b/);

  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  const toolbar = page.getByRole('region', { name: 'Navigator', exact: true });
  await toolbar.getByRole('button', { name: 'Edit Field Template' }).click();
  await expect(templateTab(page)).toHaveCount(1);
  await expect(left).toHaveClass(/\bactive\b/);
  await expect(templateTab(page)).toHaveAttribute('aria-selected', 'true');

  await page.reload();
  await expect(templateTab(page)).toHaveCount(1);
  await expect(templateTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(fields).toHaveCount(8);
  await page.getByRole('button', { name: 'Close Field Template' }).click();
  await expect(templateTab(page)).toHaveCount(0);
  const saved = await request.get(`/api/works/${work.id}/characters/template`);
  expect(await saved.json()).toEqual({ fields: getDefaultCharacterTemplate(), revision: 0 });
});

test('hides the field template command in a window without a work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Edit Field Template');
  const results = page.getByRole('listbox', { name: 'Results', exact: true });
  await expect(results).toBeVisible();
  await expect(results.getByRole('option')).toHaveCount(0);
});
