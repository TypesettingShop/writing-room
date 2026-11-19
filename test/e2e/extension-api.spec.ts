import { expect, test } from './fixtures.js';

test('drives the sample tree, context actions, status bar, messages and host restart', async ({ appPage: page }) => {
  expect(page.workers()).toHaveLength(0);
  await page.locator('[id="workbench.parts.activitybar"]').getByRole('button', { name: 'Hello World' }).click();
  const view = page.getByRole('region', { name: 'Greetings' });
  const tree = view.getByRole('tree');
  const parent = tree.getByRole('treeitem', { name: 'Greetings' });
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await parent.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Describe Greeting' })).toHaveCount(0);
  await parent.press('ArrowRight');
  const child = tree.getByRole('treeitem', { name: /Hello from Writing Room/ });
  await expect(child).toBeVisible();
  await child.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Describe Greeting' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(child).toContainText('Viewed 1');
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await child.click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(child).toContainText('Viewed 2');

  const status = page.getByRole('button', { name: 'Hello World status' });
  await expect(status.locator('.codicon-beaker')).toBeVisible();
  await view.getByRole('button', { name: 'Say Hello' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Hello from the extension host!' })).toBeVisible();
  await expect(status.locator('.codicon-megaphone')).toBeVisible();
  await page.getByRole('button', { name: 'Greet', exact: true }).click();
  await expect(status).toContainText('Greet');
  await status.click();
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await expect(status).toContainText('Hello World');

  const oldWorker = page.workers()[0];
  const closed = oldWorker.waitForEvent('close');
  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Restart Extension Host');
  await page.getByRole('option', { name: /Restart Extension Host/ }).click();
  await closed;
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  await parent.press('ArrowRight');
  await expect(child).toContainText('Sample');
  await expect(status).toContainText('Hello World');
});
