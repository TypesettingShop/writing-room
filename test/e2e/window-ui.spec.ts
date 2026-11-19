import { expect, test } from './fixtures.js';
import { message, openWindowUiFixture, runCommand } from './window-ui.helpers.js';

test('an extension picks one item, many items and a name, and gets its own objects back', async ({ page }) => {
  await openWindowUiFixture(page);
  await runCommand(page, 'Window UI: Pick Fruit');
  const picker = page.getByRole('combobox', { name: 'Pick a fruit' });
  await expect(picker).toBeFocused();
  await expect(page.getByRole('option')).toHaveText(['Apple red', 'Banana yellow', 'Lemon sour']);
  await expect(page.getByRole('group', { name: 'Citrus' }).getByRole('option')).toHaveText(['Lemon sour']);
  await picker.fill('yell');
  await expect(page.getByRole('option')).toHaveText(['Banana yellow']);
  await picker.press('Enter');
  await expect(message(page, 'Picked: Banana (same object)')).toBeVisible();

  await runCommand(page, 'Window UI: Pick Many');
  const drinks = page.getByRole('combobox', { name: 'Pick drinks' });
  await expect(page.getByRole('option', { checked: true })).toHaveText(['Tea', 'Water']);
  await drinks.press('ArrowDown');
  await drinks.press('Control+Space');
  await expect(page.getByRole('option', { name: 'Coffee' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('option', { name: 'Tea' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(message(page, 'Drinks: Coffee, Water')).toBeVisible();

  await runCommand(page, 'Window UI: Ask Name');
  const name = page.getByRole('textbox', { name: 'Name the note' });
  await expect(name).toHaveValue('N');
  await expect(page.getByText('Too short', { exact: true })).toBeVisible();
  await name.press('Enter');
  await expect(name).toBeVisible();
  await name.fill('Notes');
  await expect(page.getByText('Too short', { exact: true })).toHaveCount(0);
  await name.press('Enter');
  await expect(message(page, 'Name: Notes')).toBeVisible();
  await expect(name).toHaveCount(0);
});

test('a refreshed quick pick keeps the highlight on the same item, and focus returns to the editor', async ({ page }) => {
  await openWindowUiFixture(page);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
  const editor = page.locator('[data-group-id]').first().getByRole('textbox', { name: 'Editor content' });
  await expect(editor).toBeFocused({ timeout: 20_000 });

  await runCommand(page, 'Window UI: Search Notes');
  const search = page.getByRole('combobox', { name: 'Search notes' });
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Recipe', selected: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh notes' }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('option')).toHaveText(['New note', 'Draft', 'Diary', 'Recipe', 'Reading list']);
  await expect(page.getByRole('option', { name: 'Recipe', selected: true })).toBeVisible();
  await search.fill('zz');
  await expect(page.getByRole('option')).toHaveText(['New note']);
  await search.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(editor).toBeFocused();

  await runCommand(page, 'Window UI: Pick Fruit');
  await page.getByRole('combobox', { name: 'Pick a fruit' }).press('Escape');
  await expect(message(page, 'Picked: nothing')).toBeVisible();
  await expect(editor).toBeFocused();
});
