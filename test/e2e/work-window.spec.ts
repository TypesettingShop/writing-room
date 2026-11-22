import { box, drag, expect, test } from './fixtures.js';
import { part, treeItem } from './explorer.helpers.js';
import {
  expectEditorText, focusEditorEnd, groups, listBackups, selectedTab, waitForStorage, writeWorkspaceFile,
} from './files.helpers.js';

const workA = '12345678-abcd-4000-8000-123456789abc';
const workB = '23456789-abcd-4000-8000-123456789abc';

test.use({ viewport: { width: 1280, height: 800 } });

test('isolates the layout, open file and dirty draft by Work while sharing the practice folder', async ({ page }) => {
  await page.goto(`/?work=${workA}`);
  await waitForStorage(page);
  const sidebar = part(page, 'sidebar');
  const initial = await box(sidebar);
  await drag(page, initial.x + initial.width, 190, initial.x + 235, 190);
  await expect.poll(async () => (await box(sidebar)).width).toBe(235);

  const draft = treeItem(page, 'draft.txt');
  const group = groups(page).first();
  await writeWorkspaceFile(page, 'draft.txt', 'saved');
  await draft.click();
  await expectEditorText(group, 'saved');
  await focusEditorEnd(page, group);
  await page.keyboard.type(' and unsaved');
  await expect.poll(async () => (await listBackups(page)).map(path => path.split('/backups/')[0]))
    .toEqual([`/User/workspaceStorage/work-${workA}`]);

  for (const url of [`/?work=${workB}`, '/']) {
    await page.goto(url);
    await expect(group.getByRole('tab')).toHaveText(['Welcome']);
    await expect.poll(async () => (await box(sidebar)).width).toBe(initial.width);
    await draft.click();
    await expectEditorText(group, 'saved');
    await expect(selectedTab(group)).toHaveAccessibleDescription('');
  }

  await page.goto(`/?work=${workA}`);
  await expect(selectedTab(group)).toHaveText('draft.txt');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expectEditorText(group, 'saved and unsaved');
  await expect.poll(async () => (await box(sidebar)).width).toBe(235);
});

test('invalid Work links warn, keep the rest of the URL and use the legacy workspace', async ({ page }) => {
  const invalid = [workA.toUpperCase(), workA.slice(1), '../', '%2F', `${workA}%0A`, '', `${workA}&work=${workB}`];
  for (const value of invalid) {
    await page.goto(`/?%77ork=${value}&?work=literal&keep=a%20b&flag&path=/x#section`);
    await expect(page.getByText('The Work link is not valid.', { exact: true })).toBeVisible();
    // The other pairs keep their original spelling.
    await expect(page).toHaveURL(/\/\?\?work=literal&keep=a%20b&flag&path=\/x#section$/);
    await expect(groups(page).first().getByRole('tab')).toHaveText(['Welcome']);
  }
  await page.reload();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain('writing-room:storage:1:memento/workbench.parts.editor');
  expect(keys.filter(key => key.startsWith('writing-room:storage:work:'))).toEqual([]);
});
