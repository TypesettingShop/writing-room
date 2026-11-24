import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { CharacterValues } from '../../src/platform/characters/common/characterFields.js';
import type { CharacterTree } from '../../src/platform/characters/common/characters.js';
import type { CharacterTemplateSnapshot } from '../../src/platform/characters/common/charactersStore.js';
import { getDefaultCharacterTemplate } from '../../src/platform/characters/common/defaultCharacterTemplate.js';
async function templateCommand(page: Page): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox', { name: 'Type a command' }).fill('Edit Field Template');
  await page.getByRole('option', { name: 'Characters: Edit Field Template', exact: true }).click();
}
const templateTab = (page: Page) => page.getByRole('tab', { name: 'Field Template', exact: true });
const templatePane = (page: Page) => page.getByRole('region', { name: 'Field Template', exact: true });
const fieldRows = (page: Page) => templatePane(page).getByRole('list', { name: 'Template fields' }).getByRole('listitem');
const card = (page: Page) => page.getByRole('region', { name: 'Character card', exact: true });

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', {
    headers, data: { title: 'Field template acceptance' },
  });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const api = `/api/works/${work.id}/characters`;
  async function tree(): Promise<CharacterTree> {
    const response = await request.get(api + '/tree');
    expect(response.ok()).toBe(true);
    return response.json();
  }
  return {
    url: '/?work=' + work.id, api, headers, tree,
    async template(): Promise<CharacterTemplateSnapshot> {
      const response = await request.get(api + '/template');
      expect(response.ok()).toBe(true);
      return response.json();
    },
    async add(title: string): Promise<string> {
      const response = await request.post(api + '/nodes', {
        headers, data: { kind: 'character', title, parentId: null, expectedRevision: (await tree()).revision },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).node.id;
    },
    async setValues(id: string, values: CharacterValues): Promise<void> {
      const response = await request.patch(api + '/nodes/' + id, {
        headers, data: { values, expectedRevision: (await tree()).revision },
      });
      expect(response.ok()).toBe(true);
    },
  };
}

async function openCardAndTemplate(page: Page, url: string, title: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('treeitem', { name: title, exact: true }).dblclick();
  await card(page).getByRole('textbox', { name: '목표와 욕구', exact: true }).waitFor();
  await page.getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await templateCommand(page);
}

test('opens the saved field template from the palette and toolbar, reuses its group and restores the tab', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);

  await templateCommand(page);
  await expect(templateTab(page)).toHaveAttribute('aria-selected', 'true');
  const fields = fieldRows(page);
  await expect(fields).toHaveCount(8);
  for (const [index, field] of getDefaultCharacterTemplate().entries()) {
    await expect(fields.nth(index).getByRole('textbox', { name: 'Label', exact: true })).toHaveValue(field.label);
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
  expect(await work.template()).toEqual({ fields: getDefaultCharacterTemplate(), revision: 0 });
});

test('edits fields and choices, reorders by keyboard, and updates the open card', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.add('Rin');
  await openCardAndTemplate(page, work.url, 'Rin');
  const template = templatePane(page);
  const rows = fieldRows(page);
  await expect(rows).toHaveCount(8);
  await template.getByRole('button', { name: 'Add Field', exact: true }).press('Enter');
  await expect(rows).toHaveCount(9);
  const newId = (await rows.last().getAttribute('data-template-field'))!;
  const added = template.locator(`[data-template-field="${newId}"]`);
  const label = added.getByRole('textbox', { name: 'Label', exact: true });
  await expect(label).toBeFocused();
  await label.fill('');
  await expect(added.getByText('Label cannot be empty.')).toBeVisible();
  await label.fill('Motivation');
  await added.getByRole('textbox', { name: 'Section', exact: true }).fill('Relationships');
  await added.getByRole('textbox', { name: 'Placeholder', exact: true }).fill('Choose a motivation');
  await added.getByRole('combobox', { name: 'Kind' }).selectOption('Choice');
  await expect(added.getByText('Add at least one option.')).toBeVisible();
  await label.press('ControlOrMeta+s');
  await expect(page.getByText('Could not save the field template. Add at least one option.', { exact: true })).toBeVisible();
  expect((await work.template()).revision).toBe(0);

  const addOption = added.getByRole('button', { name: 'Add Option', exact: true });
  await addOption.click();
  await added.getByRole('textbox', { name: 'Option 1', exact: true }).fill('Belonging');
  await addOption.click();
  await added.getByRole('textbox', { name: 'Option 2', exact: true }).fill('Freedom');
  await addOption.click();
  await added.getByRole('textbox', { name: 'Option 3', exact: true }).fill('Outdated option');
  await added.getByRole('button', { name: 'Delete Option' }).last().click();
  await added.getByRole('button', { name: 'Move Option Up' }).last().click();

  await added.press('Alt+ArrowUp');
  await expect(rows.nth(7)).toHaveAttribute('data-template-field', newId);
  await expect(added).toBeFocused();
  await added.press('Alt+ArrowUp');
  await expect(rows.nth(6)).toHaveAttribute('data-template-field', newId);
  await expect(added).toBeFocused();

  await added.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields[6]).toEqual({
    id: newId, label: 'Motivation', kind: 'choice', section: 'Relationships', placeholder: 'Choose a motivation',
    options: ['Freedom', 'Belonging'],
  });
  const choice = card(page).getByRole('combobox', { name: 'Motivation' });
  await expect(choice.getByRole('option')).toHaveText(['—', 'Freedom', 'Belonging']);
  await expect(card(page).getByRole('combobox').first()).toHaveAccessibleName('Motivation');

  const remove = added.getByRole('button', { name: 'Delete Field', exact: true });
  await remove.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(rows).toHaveCount(9);
  await remove.press('Enter');
  await dialog.getByRole('button', { name: 'Delete Field', exact: true }).press('Enter');
  await expect(rows).toHaveCount(8);
  await rows.first().press('ControlOrMeta+s');
  await expect(choice).toHaveCount(0);

  await rows.first().getByRole('button', { name: 'Move Down', exact: true }).click();
  await rows.first().press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields[0].id).toBe('flaw');
  await template.getByRole('button', { name: 'Reset to Default Template', exact: true }).click();
  await dialog.getByRole('button', { name: 'Reset to Default Template', exact: true }).click();
  await rows.first().press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields).toEqual(getDefaultCharacterTemplate());
});

test('drops a field at the position indicated by the pointer drag marker', async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await templateCommand(page);
  const rows = fieldRows(page);
  const handle = rows.first().getByRole('button', { name: 'Drag Field to Reorder' });
  await expect(handle).toBeInViewport();
  const secondRow = rows.nth(1);
  await expect(secondRow).toBeInViewport({ ratio: 1 });
  const source = (await handle.boundingBox())!;
  const target = (await secondRow.boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 10, { steps: 5 });
  await expect(secondRow).toHaveAttribute('data-template-drop', 'after');
  await page.mouse.up();
  await expect(rows.first()).toHaveAttribute('data-template-field', 'flaw');
  await expect(secondRow).toHaveAttribute('data-template-field', 'goal');
  await expect(secondRow).toBeFocused();
  await secondRow.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields[0].id).toBe('flaw');
});

test('saves native Hangul composition without replacing the focused label or moving its row', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await templateCommand(page);
  const rows = fieldRows(page);
  await expect(rows).toHaveCount(8);
  const field = rows.nth(1);
  const label = field.getByRole('textbox', { name: 'Label', exact: true });
  await label.fill('');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await label.dispatchEvent('keydown', { key: 'ArrowUp', altKey: true, isComposing: true });
  await expect(field).toHaveAttribute('data-template-field', 'flaw');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields[1].label).toBe('한');
  await expect(label).toBeFocused();
  await cdp.send('Input.imeSetComposition', { text: '한국', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '한국' });
  await expect(label).toHaveValue('한국');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.template()).fields[1].label).toBe('한국');
});

test('keeps removed values through card saves and restores them with the default template', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const rin = await work.add('Rin');
  const kai = await work.add('Kai');
  await work.setValues(rin, { appearance: 'White coat', role: '조연' });
  await work.setValues(kai, { appearance: 'Blue scarf' });
  const savedValues = async () => (await work.tree()).nodes.find(node => node.id === rin)?.values;

  await openCardAndTemplate(page, work.url, 'Rin');
  const template = templatePane(page);
  const appearance = card(page).getByRole('textbox', { name: '외형', exact: true });
  const goal = card(page).getByRole('textbox', { name: '목표와 욕구', exact: true });
  const appearanceRow = template.locator('[data-template-field="appearance"]');
  const roleRow = template.locator('[data-template-field="role"]');
  await expect(appearance).toHaveValue('White coat');
  const dialog = page.getByRole('dialog');
  const removeAppearance = appearanceRow.getByRole('button', { name: 'Delete Field' });
  await page.route(`**${work.api}/tree`, route => route.fulfill({ status: 503 }), { times: 1 });
  await removeAppearance.click();
  await expect(dialog.getByText(/The number of characters with a value could not be checked/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await removeAppearance.click();
  await expect(dialog.getByText(/2 characters have a value in this field/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete Field', exact: true }).click();
  await roleRow.press('ControlOrMeta+s');
  await expect(appearance).toHaveCount(0);

  await goal.fill('Find a friend');
  await goal.press('ControlOrMeta+s');
  await expect.poll(savedValues).toEqual({ appearance: 'White coat', role: '조연', goal: 'Find a friend' });

  await roleRow.getByRole('button', { name: 'Delete Option' }).nth(1).click();
  await roleRow.press('ControlOrMeta+s');
  const warning = card(page).getByRole('status', { name: 'Invalid saved value for 역할' });
  const original = card(page).getByRole('textbox', { name: 'Original value for 역할' });
  await expect(warning).toBeVisible();
  await expect(original).toHaveValue('조연');
  await expect(original).not.toBeEditable();
  await goal.fill('Bring a letter');
  await goal.press('ControlOrMeta+s');
  await expect.poll(savedValues).toEqual({ appearance: 'White coat', role: '조연', goal: 'Bring a letter' });

  const choice = card(page).getByRole('combobox', { name: '역할', exact: true });
  await choice.selectOption('주연');
  await choice.press('ControlOrMeta+s');
  await expect(warning).toBeHidden();
  await expect.poll(savedValues).toEqual({ appearance: 'White coat', role: '주연', goal: 'Bring a letter' });

  await template.getByRole('button', { name: 'Reset to Default Template' }).click();
  await dialog.getByRole('button', { name: 'Reset to Default Template', exact: true }).click();
  await appearanceRow.press('ControlOrMeta+s');
  await expect(appearance).toHaveValue('White coat');
  await expect(choice).toHaveValue('주연');
});

test('refreshes an open card after its next save when another window changes the template', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await work.setValues(id, { goal: 'Original value' });
  await page.goto(work.url);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Rin', exact: true }).dblclick();
  const goal = card(page).getByRole('textbox', { name: '목표와 욕구', exact: true });
  await expect(goal).toHaveValue('Original value');

  const other = await page.context().newPage();
  try {
    await other.goto(work.url);
    await templateCommand(other);
    const goalLabel = templatePane(other).locator('[data-template-field="goal"]').getByRole('textbox', { name: 'Label', exact: true });
    await goalLabel.fill('New goal label');
    await goalLabel.press('ControlOrMeta+s');
    await expect.poll(async () => (await work.template()).fields[0].label).toBe('New goal label');
    await expect(goal).toHaveValue('Original value');

    const revision = (await work.tree()).revision;
    await goal.press('ControlOrMeta+s');
    await expect(card(page).getByRole('textbox', { name: 'New goal label', exact: true })).toHaveValue('Original value');
    expect((await work.tree()).revision).toBe(revision);
  } finally {
    await other.close();
  }
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
