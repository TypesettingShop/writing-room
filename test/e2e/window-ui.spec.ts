import { expect, test } from './fixtures.js';
import { message, openWindowUiFixture, outputView, runCommand } from './window-ui.helpers.js';

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

test('an output channel gets 10,000 lines in order and shows them, keeping focus when asked', async ({ page }) => {
  await openWindowUiFixture(page);
  const { panel, tab, channels, log } = outputView(page);
  await expect(channels).toBeVisible();
  await expect(page.getByText('No output yet')).toHaveCount(0);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File' }).click();
  const editor = page.locator('[data-group-id]').first().getByRole('textbox', { name: 'Editor content' });
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await runCommand(page, 'View: Toggle Panel Visibility');
  await expect(panel).toBeHidden();

  await runCommand(page, 'Window UI: Write Output');
  await expect(message(page, 'Wrote round 1')).toBeVisible();
  await expect(panel).toBeHidden();
  await runCommand(page, 'Window UI: Show Output');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(channels.getByRole('option', { name: 'Window UI', selected: true })).toBeVisible();
  const lines = log.locator(':scope > *');
  await expect(lines).toHaveCount(10_000);
  await expect(lines.first()).toHaveText('round 1 line 0');
  await expect(lines.last()).toHaveText('round 1 line 9999');
  await expect(lines.last()).toBeInViewport();
  await expect(editor).toBeFocused();

  // A log channel writes from its level up, with the time and level, and takes focus when shown.
  await runCommand(page, 'Window UI: Write Log');
  await expect(channels.getByRole('option', { name: 'Window UI Log', selected: true })).toBeVisible();
  await expect(log).toBeFocused();
  const time = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}`;
  await expect(log.locator(':scope > *')).toHaveText([
    new RegExp(`^${time} \\[info\\] an info line$`),
    new RegExp(`^${time} \\[warning\\] a warning line$`),
  ]);
  await channels.getByRole('option', { name: 'Window UI', exact: true }).click();
  await expect(lines.last()).toHaveText('round 1 line 9999');
});

test('output written while the view is hidden is there when it shows; cleared output stays gone', async ({ page }) => {
  await openWindowUiFixture(page);
  const { panel, tab, channels, log } = outputView(page);
  await runCommand(page, 'Window UI: Show Output');
  await expect(channels.getByRole('option', { name: 'Window UI', selected: true })).toBeVisible();
  await panel.getByRole('tab', { name: 'Problems' }).click();
  await expect(log).toBeHidden();

  await runCommand(page, 'Window UI: Write Output');
  await expect(message(page, 'Wrote round 1')).toBeVisible();
  await tab.click();
  const lines = log.locator(':scope > *');
  await expect(lines.last()).toHaveText('round 1 line 9999');
  await expect(lines).toHaveCount(10_000);

  await panel.getByRole('button', { name: 'Clear Output' }).click();
  await expect(lines).toHaveCount(0);
  await runCommand(page, 'Window UI: Write Output');
  await expect(lines.last()).toHaveText('round 2 line 9999');
  await expect(lines).toHaveCount(10_000);
  await expect(log.getByText('round 1', { exact: false })).toHaveCount(0);

  // A disposed channel leaves the list, and using it afterwards throws as in VS Code.
  await runCommand(page, 'Window UI: Close Output');
  await expect(message(page, 'Closed output: Channel has been closed')).toBeVisible();
  await expect(channels.getByRole('option')).toHaveCount(0);
  await expect(lines).toHaveCount(0);
});

test('a modal message traps focus, keeps the workbench out of reach and answers Escape with its close item', async ({ page }) => {
  await openWindowUiFixture(page);
  await runCommand(page, 'Window UI: Confirm Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete <b>the draft</b>?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('It cannot be undone.');
  await expect(dialog).toContainText('Source: Window UI Fixture');
  await expect(dialog.getByRole('button')).toHaveText(['Delete', 'Keep']);
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
  }
  // A click behind the dialog reaches nothing.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(message(page, 'Confirm: Keep (same object)')).toBeVisible();

  await runCommand(page, 'Window UI: Confirm Delete');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(message(page, 'Confirm: Delete (same object)')).toBeVisible();
});

test('notification progress fills, cancels once and goes when the task ends; window progress spins in the status bar', async ({ page }) => {
  await openWindowUiFixture(page);
  await runCommand(page, 'Window UI: Export');
  const toast = page.locator('.extension-toast').filter({ hasText: 'Exporting' });
  await expect(toast.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(toast.getByRole('status')).toHaveText('Exporting: chapter 3');
  await expect(toast).toContainText('Source: Window UI Fixture');
  await toast.getByRole('button', { name: 'Cancel' }).click();
  await expect(toast.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true');
  await expect(message(page, 'Export: cancelled')).toBeVisible();
  await expect(toast).toHaveCount(0);

  await runCommand(page, 'Window UI: Index');
  const statusbar = page.locator('[id="workbench.parts.statusbar"]');
  const indexing = statusbar.getByLabel('Indexing: notes');
  await expect(indexing).toBeVisible();
  await expect(indexing.locator('.codicon-loading.codicon-modifier-spin')).toBeVisible();
  await expect(message(page, 'Index: index failed')).toBeVisible();
  await expect(indexing).toHaveCount(0);

  await runCommand(page, 'Window UI: Status Message');
  const status = statusbar.getByText('Refreshing notes');
  await expect(status).toBeVisible();
  const icon = statusbar.locator('.codicon-refresh.codicon-modifier-spin');
  expect(await icon.evaluate(element => getComputedStyle(element).animationName)).toBe('codicon-spin');
});

test('three toasts show at once and the waiting ones follow; the v0.1.0 buttons still answer', async ({ page }) => {
  await openWindowUiFixture(page);
  await runCommand(page, 'Window UI: Flood');
  const toasts = page.locator('.extension-toast');
  await expect(toasts).toHaveCount(3);
  await expect(toasts.getByRole('status')).toHaveText(['Flood 1', 'Flood 2', 'Flood 3']);
  await toasts.first().getByRole('button', { name: 'Dismiss message' }).click();
  await expect(toasts.getByRole('status')).toHaveText(['Flood 2', 'Flood 3', 'Flood 4']);
  await toasts.first().getByRole('button', { name: 'Dismiss message' }).press('Escape');
  await expect(toasts.getByRole('status')).toHaveText(['Flood 3', 'Flood 4', 'Flood 5']);
});
