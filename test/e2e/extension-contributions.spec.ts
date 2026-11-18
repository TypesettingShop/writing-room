import { expect, test } from './fixtures.js';

test('shows manifest contributions in the view, editor title and command palette', async ({ appPage: page }) => {
  const editor = page.getByRole('main');
  await expect(editor.getByRole('button', { name: 'Show Extension Host' })).toBeVisible();
  const activity = page.locator('[id="workbench.parts.activitybar"]');
  const hello = activity.getByRole('button', { name: 'Hello World' });
  await expect(hello.locator('.codicon-beaker')).toBeVisible();
  await hello.click();
  const view = page.getByRole('region', { name: 'Greetings' });
  await expect(view).toBeVisible();
  await expect(view.getByRole('button', { name: 'Say Hello' })).toBeVisible();
  await page.keyboard.press('F1');
  const input = page.getByRole('combobox');
  await input.fill('Say Hello');
  await expect(page.getByRole('option', { name: /Hello World.*Say Hello/ })).toContainText('F8');
});
