import type { Page } from '@playwright/test';
import { runCommand } from './configuration.helpers.js';
import { part, treeItem } from './explorer.helpers.js';
import { answerCloseQuestion, expectEditorText, focusEditorEnd, groups, writeWorkspaceFile } from './files.helpers.js';
import { expect, test } from './fixtures.js';

async function workMenu(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Work', exact: true }).click();
  return page.getByRole('menu', { name: 'Work', exact: true });
}

test('creates a Work from the menu and identifies it in the Work picker', async ({ page }) => {
  await page.goto('/?keep=a%20b&flag');
  const labels = page.getByRole('menubar').getByRole('menuitem');
  await expect(labels.nth(0)).toHaveText('Work');
  await expect(labels.nth(1)).toHaveText('File');
  const menu = await workMenu(page);
  await expect(menu.getByRole('menuitem')).toHaveText(['New Work...', 'Open Work...', 'Close Work']);
  await expect(menu.getByRole('menuitem', { name: 'Close Work' })).toHaveAttribute('aria-disabled', 'true');

  await menu.getByRole('menuitem', { name: 'New Work...' }).click();
  const title = page.getByRole('textbox', { name: 'Enter text' });
  await expect(title).toBeFocused();
  await title.fill('x'.repeat(201));
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Enter a Work title of 1–200 characters/)).toBeVisible();
  await title.fill('Work menu acceptance');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?keep=a%20b&flag&work=[0-9a-f-]{36}$/);
  await expect(page).toHaveTitle('Work menu acceptance');

  const activeMenu = await workMenu(page);
  await expect(activeMenu.getByRole('menuitem', { name: 'Close Work' })).toBeEnabled();
  const navigationEntries = () => page.evaluate(() => performance.timeOrigin);
  const originalWindow = await navigationEntries();
  await activeMenu.getByRole('menuitem', { name: 'Open Work...' }).click();
  await page.getByRole('option', { name: /Work menu acceptance.*\(current\)/ }).click();
  await expect(page).toHaveURL(/\?keep=a%20b&flag&work=[0-9a-f-]{36}$/);
  await expect(page).toHaveTitle('Work menu acceptance');
  expect(await navigationEntries()).toBe(originalWindow);
});

test('a canceled Work switch leaves earlier groups and their changes open', async ({ page, request, baseURL }) => {
  const headers = { Origin: new URL(baseURL!).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Work close acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  await page.goto('/?work=' + work.id);
  await expect(page).toHaveTitle(work.title);

  const first = groups(page).first();
  const second = groups(page).nth(1);
  await writeWorkspaceFile(page, 'first.txt', 'First');
  await writeWorkspaceFile(page, 'second.txt', 'Second');
  await treeItem(page, 'first.txt').click();
  await runCommand(page, 'Split Editor', /^View: Split Editor$/);
  await expect(second.getByRole('tab', { name: 'first.txt' })).toBeVisible();
  await treeItem(page, 'second.txt').click();
  for (const group of [first, second]) {
    await focusEditorEnd(page, group);
    await page.keyboard.type(' unsaved');
  }

  await (await workMenu(page)).getByRole('menuitem', { name: 'Close Work' }).click();
  await answerCloseQuestion(page, 'first.txt', "Don't Save");
  await answerCloseQuestion(page, 'second.txt', 'Cancel');
  await expect(page).toHaveURL('/?work=' + work.id);
  await expectEditorText(first, 'First unsaved');
  await expectEditorText(second, 'Second unsaved');

  await (await workMenu(page)).getByRole('menuitem', { name: 'Close Work' }).click();
  await answerCloseQuestion(page, 'first.txt', 'Save');
  await answerCloseQuestion(page, 'second.txt', "Don't Save");
  await expect(page).toHaveURL('/');
  const works = page.getByRole('region', { name: 'Works', exact: true });
  await expect(works).toBeFocused();
  const listedWork = works.getByRole('button', { name: work.title, exact: true });
  await expect(listedWork).toBeVisible();
  await expect(part(page, 'editor')).toBeVisible();
  await listedWork.click();
  await expect(page).toHaveURL('/?work=' + work.id);
  await expect(page).toHaveTitle(work.title);
});

test('canceling New Work at the save prompt leaves the server list unchanged', async ({ page, request }) => {
  const workTitle = 'Work creation cancellation';
  const listCreated = async () => {
    const response = await request.get('/api/works');
    expect(response.ok()).toBe(true);
    const { works } = await response.json();
    return works.filter((work: { title: string }) => work.title === workTitle);
  };
  await page.goto('/');
  await page.getByRole('button', { name: 'New Text File...' }).click();
  const draft = page.getByRole('textbox', { name: 'Editor content' });
  await expect(draft).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type('unsaved text');

  const submitNewWork = async () => {
    await (await workMenu(page)).getByRole('menuitem', { name: 'New Work...' }).click();
    await page.getByRole('textbox', { name: 'Enter text' }).fill(workTitle);
    await page.keyboard.press('Enter');
  };
  await submitNewWork();
  await answerCloseQuestion(page, 'Untitled-1', 'Cancel');
  await expect(page).toHaveURL('/');
  await expectEditorText(groups(page).first(), 'unsaved text');
  expect(await listCreated()).toHaveLength(0);

  await submitNewWork();
  await answerCloseQuestion(page, 'Untitled-1', "Don't Save");
  await expect(page).toHaveURL(/\?work=[0-9a-f-]{36}$/);
  await expect(page).toHaveTitle(workTitle);
  expect(await listCreated()).toHaveLength(1);
});
