import { expect, test } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  test.skip(process.env.E2E_TARGET === 'preview', 'Keybinding harness is available only in development');
  const response = await page.goto('/test/harness/keybindings.html');
  expect(response?.ok()).toBe(true);
});

test('dispatches function keys and modifiers once and shows the real label in a menu', async ({ page }) => {
  await page.getByRole('button', { name: 'Normal Area' }).focus();
  await page.keyboard.press('F8');
  await page.keyboard.press('Control+F8');
  await expect(page.getByRole('status', { name: 'Commands Run' })).toHaveText('Function Key Modifier Key');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  const item = page.getByRole('menuitem', { name: 'Modifier Key' });
  await expect(item).toContainText('Ctrl+F8');
  await expect(item).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('lets unmodified letters through to text inputs and consumes both strokes of a chord', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Text Entry' });
  await input.press('x');
  await expect(input).toHaveValue('x');
  await expect(page.getByRole('status')).toBeEmpty();
  await input.press('Control+k');
  await input.press('Control+s');
  await expect(page.getByRole('status')).toHaveText('Chord');
  // A plain letter that completes a chord must not also be typed into the input.
  await input.press('Control+k');
  await input.press('z');
  await expect(page.getByRole('status')).toHaveText('Chord Letter Chord');
  await expect(input).toHaveValue('x');
});
