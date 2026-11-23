import { expect, test } from '@playwright/test';
import { chooseOption, groups, listBackups, selectedTab } from './files.helpers.js';
import { append, createManuscript, markdown, openManuscript, save } from './manuscript-storage.helpers.js';

test('restores a saved manuscript, keeps a conflicting draft and reports an unavailable server', async ({ page, baseURL, request }) => {
  const { workId, nodeId, documentPath: doc } = await createManuscript(request, baseURL!);
  const stored = async () => (await (await request.get(doc)).text()).trimEnd();

  await openManuscript(page, workId, nodeId);
  await expect(markdown(page).locator('p')).toHaveText('Draft', { timeout: 20_000 });
  await append(page, ' saved');
  await save(page);
  await expect.poll(stored).toBe('Draft saved');
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('');

  await page.reload();
  await expect(markdown(page).locator('p')).toHaveText('Draft saved', { timeout: 20_000 });
  await append(page, ' mine');

  const other = await page.context().newPage();
  try {
    await openManuscript(other, workId, nodeId);
    await expect(markdown(other).locator('p')).toHaveText('Draft saved', { timeout: 20_000 });
    await append(other, ' theirs');
    await save(other);
    await expect.poll(stored).toBe('Draft saved theirs');
  } finally {
    await other.close();
  }

  await save(page);
  await expect(page.getByText(/The content of the file is newer/)).toBeVisible();
  await chooseOption(page, 'Cancel');
  await expect(markdown(page).locator('p')).toHaveText('Draft saved mine');
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
  expect(await stored()).toBe('Draft saved theirs');

  await page.route('**' + doc, route => route.abort('connectionrefused'));
  await save(page);
  await expect(page.getByText(/The manuscript server is unavailable/)).toBeVisible();
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
  expect(await stored()).toBe('Draft saved theirs');
});

test('restores a manuscript draft only in its own work', async ({ page, baseURL, request }) => {
  const { workId, nodeId } = await createManuscript(request, baseURL!);
  const other = await createManuscript(request, baseURL!);
  await openManuscript(page, workId, nodeId);
  await expect(markdown(page).locator('p')).toHaveText('Draft', { timeout: 20_000 });
  await append(page, ' belongs here');
  await expect.poll(async () => (await listBackups(page)).map(path => path.split('/backups/')[0]))
    .toEqual(['/User/workspaceStorage/work-' + workId]);

  for (const url of ['/?work=' + other.workId, '/']) {
    await page.goto(url);
    await expect(groups(page).first().getByRole('tab')).toHaveText(['Welcome']);
    await expect(markdown(page)).toHaveCount(0);
  }

  await page.goto('/?work=' + workId);
  await expect(markdown(page).locator('p')).toHaveText('Draft belongs here', { timeout: 20_000 });
  await expect(selectedTab(groups(page).first())).toHaveAccessibleDescription('Modified');
});

test('shows a persistent warning for the explicit in-memory store', async ({ page }) => {
  await page.goto('/?store=memory');
  await expect(page.getByText('In-memory store: changes are lost on reload.', { exact: true })).toBeVisible();
});
