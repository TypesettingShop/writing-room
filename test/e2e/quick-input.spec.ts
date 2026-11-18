import { expect, test } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'Quick input harness is available only in development');
  const response = await page.goto('/test/harness/quick-input.html');
  expect(response?.ok()).toBe(true);
});

test('F1 uses the editor scope, filters commands, and executes after restoring the caret', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Editor' });
  await editor.focus();
  await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 9));
  await page.keyboard.press('F1');

  const picker = page.getByRole('combobox', { name: 'Type a command' });
  const list = page.getByRole('listbox');
  const options = list.getByRole('option');
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue('');
  await expect(list.getByRole('option', { name: 'Editor: Select Paragraph' })).toBeVisible();
  await page.keyboard.press('F1');
  await expect(picker).toBeFocused();
  await expect(list.getByRole('option', { name: 'Editor: Select Paragraph' })).toBeVisible();
  await expect(list.getByRole('option', { name: 'Document: Export Draft' })).toHaveAccessibleDescription('Control+E');
  await expect(list.getByRole('option', { name: /Hidden|Disabled/ })).toHaveCount(0);
  await picker.pressSequentially('draft ex');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveAccessibleName('Document: Export Draft');
  await expect(options.first().locator('mark')).toHaveText(['Ex', 'Draft']);
  await expect(picker).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id') ?? '');
  await expect(page.getByRole('status', { name: 'Commands Run' })).toBeEmpty();

  await picker.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Commands Run' })).toHaveText('Export Draft (TEXTAREA)');
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(element => {
    const input = element as HTMLTextAreaElement;
    return [input.selectionStart, input.selectionEnd];
  })).toEqual([4, 9]);
});

test('Escape cancels, and the View menu and Ctrl+Shift+P open the same palette', async ({ page }) => {
  const open = page.getByRole('button', { name: 'Open Palette' });
  await open.click();
  const picker = page.getByRole('combobox');
  await expect(picker).toBeFocused();
  await expect(page.getByRole('option', { name: 'Editor: Select Paragraph' })).toHaveCount(0);
  await picker.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByRole('status', { name: 'Commands Run' })).toBeEmpty();

  await page.getByRole('menubar').getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Command Palette...', exact: true }).click();
  await expect(picker).toBeFocused();
  await picker.press('Escape');

  await page.keyboard.press('ControlOrMeta+Shift+P');
  await expect(picker).toBeFocused();
});

test('arrow navigation wraps and row clicks accept while outside clicks cancel', async ({ page }) => {
  const open = page.getByRole('button', { name: 'Open Pick' });
  const result = page.getByRole('status', { name: 'Pick Result' });
  await open.click();
  const picker = page.getByRole('combobox', { name: 'Choose a colour' });
  const options = page.getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(page.getByRole('option', { name: 'Amber Citrus fruit', selected: true })).toBeVisible();
  await picker.press('ArrowUp');
  await expect(page.getByRole('option', { name: 'Indigo Night sky', selected: true })).toBeVisible();
  await picker.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Amber Citrus fruit', selected: true })).toBeVisible();
  await page.getByRole('option', { name: /Coral/ }).click();
  await expect(result).toHaveText('Coral');
  await expect(picker).toHaveCount(0);
  await expect(open).toBeFocused();

  await open.click();
  await page.getByText('Outside the widget').click();
  await expect(result).toHaveText('Cancelled');
  await expect(picker).toHaveCount(0);
  await expect(open).toBeFocused();

  await open.click();
  await page.getByText('Choose a colour').click();
  await picker.press('Tab');
  await expect(picker).toBeFocused();
  const editor = page.getByRole('textbox', { name: 'Editor' });
  await editor.click();
  await expect(picker).toHaveCount(0);
  await expect(editor).toBeFocused();
});

test('replacement cancels the pick and validation prevents accepting an invalid input', async ({ page }) => {
  const open = page.getByRole('button', { name: 'Open Pick' });
  await open.click();
  await expect(page.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('F7');
  const text = page.getByRole('textbox', { name: 'Name the draft' });
  await expect(text).toBeFocused();
  await expect(text).toHaveValue('New');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Pick Result' })).toHaveText('Cancelled');
  await expect(page.getByText('The name is too short.')).toBeVisible();
  await text.press('Enter');
  await expect(text).toBeVisible();
  await expect(page.getByRole('status', { name: 'Input Result' })).toBeEmpty();

  await text.fill('A longer draft');
  await expect(page.getByText('The name is too short.')).toHaveCount(0);
  const bounds = (await text.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width - 4, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 4, bounds.y + 300, { steps: 4 });
  await page.mouse.up();
  await expect(text).toBeFocused();
  await text.press('Enter');
  await expect(text).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Input Result' })).toHaveText('A longer draft');
  await expect(open).toBeFocused();
});

test('recent commands survive reload and appear once above the other commands', async ({ page }) => {
  await page.keyboard.press('F1');
  await page.getByRole('option', { name: 'View: Open Outline' }).click();
  await expect(page.getByRole('status', { name: 'Commands Run' })).toContainText('Open Outline');
  await page.reload();
  await page.keyboard.press('F1');
  const recent = page.getByRole('group', { name: 'Recently Used' });
  await expect(recent.getByRole('option')).toHaveAccessibleName('View: Open Outline');
  await expect(page.getByRole('option', { name: 'View: Open Outline' })).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Other Commands' }).getByRole('option').first())
    .toHaveAccessibleName('Document: Export Draft');
});
