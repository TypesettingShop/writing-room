import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { CharacterTree } from '../../src/platform/characters/common/characters.js';
import type { CreateCharacterNode } from '../../src/platform/characters/common/charactersStore.js';
import { answerCloseQuestion, groups, selectedTab } from './files.helpers.js';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Character cards' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const characters = '/api/works/' + work.id + '/characters';
  async function tree(): Promise<CharacterTree> {
    const response = await request.get(characters + '/tree');
    expect(response.ok()).toBe(true);
    return response.json();
  }
  return {
    url: '/?work=' + work.id, characters, headers, tree,
    async add(title: string, kind: CreateCharacterNode['kind'] = 'character', parentId: string | null = null) {
      const response = await request.post(characters + '/nodes', {
        headers, data: { title, kind, parentId, expectedRevision: (await tree()).revision },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).node.id as string;
    },
  };
}

const navigator = (page: Page) => page.getByRole('tree', { name: 'Characters Navigator' });
const row = (page: Page, name: string) => navigator(page).getByRole('treeitem', { name, exact: true });
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const menu = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });

async function showCharacters(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
}

test('opens cards from the navigator, reuses existing tabs, and tracks their names and icons', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const folder = await work.add('Cast', 'folder');
  await work.add('Rin', 'character', folder);
  await work.add('Kai', 'character', folder);
  await showCharacters(page, work.url);

  await row(page, 'Cast').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(tab(page, 'Cast')).toHaveCount(0);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');
  await row(page, 'Rin').click();
  await navigator(page).press('Enter');
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await row(page, 'Kai').click({ button: 'right' });
  await menu(page, 'Open').click();
  await expect(tab(page, 'Kai')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');

  await row(page, 'Rin').click();
  await navigator(page).press('F2');
  const rename = navigator(page).getByRole('textbox', { name: 'Title' });
  await rename.fill('Rin Updated');
  await rename.press('Enter');
  await expect(tab(page, 'Rin Updated')).toBeVisible();
  await row(page, 'Rin Updated').click({ button: 'right' });
  await menu(page, 'Set Type').click();
  await page.getByRole('menuitemradio', { name: 'Female', exact: true }).click();
  await expect(page.locator('.tab').filter({ has: tab(page, 'Rin Updated') }).locator('.codicon-character-female')).toBeVisible();

  await navigator(page).press('Backspace');
  await row(page, 'Cast').click();
  await navigator(page).press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tab(page, 'Rin Updated')).toHaveCount(0);
  await expect(tab(page, 'Kai')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps a character deleted elsewhere open and marks it deleted on refresh', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(tab(page, 'Rin')).toBeVisible();
  const response = await request.delete(work.characters + '/nodes/' + id + '?expectedRevision=' + (await work.tree()).revision, {
    headers: work.headers,
  });
  expect(response.ok()).toBe(true);
  await page.getByRole('region', { name: 'Navigator', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Character deleted', { exact: false })).toBeVisible();
  await expect(tab(page, 'Rin')).toBeVisible();
});

const card = (page: Page) => page.getByRole('region', { name: 'Character card', exact: true });
const goal = (page: Page) => card(page).getByRole('textbox', { name: '목표와 욕구' });
const tabElement = (page: Page, name: string) => page.locator('.tab').filter({ has: tab(page, name) });

test('saves the name, type and values through Ctrl+S, idle and focus leaving the card', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(goal(page)).toBeVisible();

  const saved = async () => (await work.tree()).nodes.find(node => node.id === id);
  await card(page).getByRole('textbox', { name: 'Name' }).fill('Rin Updated');
  await card(page).getByRole('button', { name: 'Female' }).click();
  await goal(page).fill('목표');
  await expect(tabElement(page, 'Rin Updated')).toHaveClass(/\bdirty\b/);
  await goal(page).press('ControlOrMeta+s');
  await expect.poll(saved).toMatchObject({
    title: 'Rin Updated', type: 'female', values: { goal: '목표' },
  });
  await expect(tabElement(page, 'Rin Updated')).not.toHaveClass(/\bdirty\b/);
  await expect(row(page, 'Rin Updated')).toBeVisible();

  await goal(page).fill('Idle save');
  await expect.poll(saved).toMatchObject({ values: { goal: 'Idle save' } });

  await goal(page).fill('Blur save');
  await row(page, 'Rin Updated').click();
  await expect.poll(saved).toMatchObject({ values: { goal: 'Blur save' } });
  await page.getByRole('button', { name: 'Close Rin Updated', exact: true }).click();
  await row(page, 'Rin Updated').dblclick();
  await expect(goal(page)).toHaveValue('Blur save');
});

test('saves Chromium native Hangul preedit on Ctrl+S and keeps the input composing', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await goal(page).focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await expect(goal(page)).toHaveValue('한');
  const saved = async () => (await work.tree()).nodes.find(node => node.id === id)?.values?.goal;
  expect(await saved()).toBeUndefined();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(saved).toBe('한');
  await expect(goal(page)).toBeFocused();

  await cdp.send('Input.imeSetComposition', { text: '한국', selectionStart: 2, selectionEnd: 2 });
  await expect(goal(page)).toHaveValue('한국');
  await cdp.send('Input.insertText', { text: '한국' });
  await expect(goal(page)).toHaveValue('한국');
  await expect.poll(saved).toBe('한국');
});

test('asks before replacing a remotely changed card and preserves values outside the template', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  async function saveElsewhere(values: Record<string, string>) {
    const response = await request.patch(work.characters + '/nodes/' + id, {
      headers: work.headers, data: { values, expectedRevision: (await work.tree()).revision },
    });
    expect(response.ok()).toBe(true);
  }
  await saveElsewhere({ goal: 'Original', hidden: 'Keep me', role: 'Retired role' });
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(goal(page)).toHaveValue('Original');
  await expect(card(page).getByRole('combobox', { name: '역할' })).toHaveValue('Retired role');

  const dialog = page.getByRole('dialog');
  await saveElsewhere({ goal: 'Another window', hidden: 'Keep me', role: 'Retired role' });
  await goal(page).fill('Local draft');
  await goal(page).press('ControlOrMeta+s');
  await expect(dialog.getByText('"Rin" changed elsewhere.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(goal(page)).toHaveValue('Another window');

  await saveElsewhere({ goal: 'Remote again', hidden: 'Keep me', role: 'Retired role' });
  await goal(page).fill('My version');
  await goal(page).press('ControlOrMeta+s');
  await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect.poll(async () => (await work.tree()).nodes.find(node => node.id === id)?.values).toEqual({
    goal: 'My version', hidden: 'Keep me', role: 'Retired role',
  });
  await expect(tabElement(page, 'Rin')).not.toHaveClass(/\bdirty\b/);
});

test('shares a draft across groups and only asks to discard it when closing the last copy', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const id = await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(goal(page)).toBeVisible();
  await page.getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(tab(page, 'Rin')).toHaveCount(2);
  const patchRoute = '**' + work.characters + '/nodes/' + id;
  let patches = 0;
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === work.characters + '/nodes/' + id) {
      patches++;
    }
  });
  // Keep the draft dirty if an autosave starts while operating the tab or command palette.
  await page.route(patchRoute, async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 503, json: { code: 'invalid' } });
    } else {
      await route.continue();
    }
  });

  await goal(page).last().fill('Shared draft');
  await expect(goal(page).first()).toHaveValue('Shared draft');
  await page.getByRole('button', { name: 'Close Rin', exact: true }).first().click();
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(goal(page)).toHaveValue('Shared draft');

  await page.getByRole('button', { name: 'Close Rin', exact: true }).click();
  await expect(page.getByRole('option', { name: /^Don't Save/ })).toBeVisible();
  // The question waits for a save in flight, so any later write comes from the question or the answer.
  const asked = patches;
  await answerCloseQuestion(page, 'Rin', "Don't Save");
  await expect(tab(page, 'Rin')).toHaveCount(0);
  // Let a stray idle save reach the server so it can fail the value check below.
  await page.unroute(patchRoute);
  await page.waitForTimeout(1500);
  expect(patches).toBe(asked);
  await expect(page.getByRole('option', { name: /^Don't Save/ })).toHaveCount(0);
  expect((await work.tree()).nodes.find(node => node.id === id)?.values).toEqual({});
});


async function dropInGroup(item: Locator, group: Locator, side: 'center' | 'right'): Promise<void> {
  const body = group.locator('.editor-container');
  const bounds = (await body.boundingBox())!;
  await item.dragTo(body, { targetPosition: { x: bounds.width * (side === 'right' ? 0.97 : 0.5), y: bounds.height / 2 } });
  await expect(group.page().locator('[data-editor-drop-position], [data-characters-drop]')).toHaveCount(0);
}

test('opens a character in the center, splits for a folder and caps the ordered drop at 50', async ({ page, request, baseURL }) => {
  test.setTimeout(60_000);
  const work = await createWork(request, baseURL!);
  await work.add('Rin');
  const folder = await work.add('Cast', 'folder');
  for (let index = 1; index <= 51; index++) {
    await work.add('Cast ' + index, 'character', folder);
  }
  await showCharacters(page, work.url);
  const left = groups(page).first();
  await dropInGroup(row(page, 'Rin'), left, 'center');
  await expect(left.getByRole('tab', { name: 'Rin', exact: true })).toBeVisible();

  await dropInGroup(row(page, 'Cast'), left, 'right');
  await expect(groups(page)).toHaveCount(2);
  const right = groups(page).last();
  await expect(right.locator('.tab-name')).toHaveText(Array.from({ length: 50 }, (_, index) => 'Cast ' + (index + 1)));
  expect((await right.boundingBox())!.x).toBeGreaterThan((await left.boundingBox())!.x);
  await expect(right.getByRole('tab', { name: 'Cast 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Opened 50 of 51 characters.')).toBeVisible();

  await dropInGroup(row(page, 'Rin'), right, 'right');
  await expect(tab(page, 'Rin')).toHaveCount(1);
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');
  await expect(groups(page)).toHaveCount(2);
});

test('opens nested folder cards from the menu, then opens a multi-selection in tree order', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const folder = await work.add('Cast', 'folder');
  const nested = await work.add('Nested', 'folder', folder);
  await work.add('Rin', 'character', nested);
  await work.add('Kai', 'character', nested);
  await work.add('Pip', 'character', folder);
  await work.add('First');
  await work.add('Second');
  await showCharacters(page, work.url);

  await row(page, 'First').click({ button: 'right' });
  await expect(menu(page, 'Open All in Folder')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row(page, 'Cast').click({ button: 'right' });
  await menu(page, 'Open All in Folder').click();
  const group = groups(page).first();
  await expect(group.locator('.tab-name')).toHaveText(['Welcome', 'Rin', 'Kai', 'Pip']);

  await row(page, 'Second').click();
  await row(page, 'First').click({ modifiers: ['ControlOrMeta'] });
  await dropInGroup(row(page, 'Second'), group, 'center');
  await expect(group.locator('.tab-name')).toHaveText(['Welcome', 'Rin', 'Kai', 'Pip', 'First', 'Second']);
});


test('restores card groups, order and active tabs, then prunes a group whose only card was deleted', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const rin = await work.add('Rin');
  await work.add('Kai');
  const pip = await work.add('Pip');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await row(page, 'Kai').dblclick();
  const left = groups(page).first();
  await dropInGroup(row(page, 'Pip'), left, 'right');
  await expect(groups(page)).toHaveCount(2);
  const right = groups(page).last();
  await expect(selectedTab(left)).toHaveText('Kai');
  await expect(selectedTab(right)).toHaveText('Pip');

  const rename = await request.patch(work.characters + '/nodes/' + rin, {
    headers: work.headers, data: { title: 'Rin elsewhere', type: 'animal', expectedRevision: (await work.tree()).revision },
  });
  expect(rename.ok()).toBe(true);
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  const route = '**' + work.characters + '/tree';
  await page.route(route, async request => {
    await delay;
    await request.continue();
  });
  try {
    await page.reload();
    await expect(tab(page, 'Loading character…')).toHaveCount(3);
  } finally {
    release();
  }
  await expect(left.locator('.tab-name')).toHaveText(['Welcome', 'Rin elsewhere', 'Kai']);
  await expect(right.locator('.tab-name')).toHaveText(['Pip']);
  await expect(selectedTab(left)).toHaveText('Kai');
  await expect(selectedTab(right)).toHaveText('Pip');
  await expect(right).toHaveClass(/(?:^| )active(?: |$)/);
  await expect(tabElement(page, 'Rin elsewhere').locator('.codicon-character-animal')).toBeVisible();
  await page.unroute(route);

  const deleted = await request.delete(work.characters + '/nodes/' + pip + '?expectedRevision=' + (await work.tree()).revision, {
    headers: work.headers,
  });
  expect(deleted.ok()).toBe(true);
  await page.reload();
  await expect(tab(page, 'Pip')).toHaveCount(0);
  await expect(groups(page)).toHaveCount(1);
  await expect(left.locator('.tab-name')).toHaveText(['Welcome', 'Rin elsewhere', 'Kai']);
  await expect(selectedTab(left)).toHaveText('Kai');
});

test('keeps a restored card during a failed tree read and retries in its own tab', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await work.add('Rin');
  await showCharacters(page, work.url);
  await row(page, 'Rin').dblclick();
  await expect(goal(page)).toBeVisible();
  const route = '**' + work.characters + '/tree';
  await page.route(route, request => request.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }));

  await page.reload();
  await expect(tab(page, 'Character unavailable')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page).getByText('Could not load the character.')).toBeVisible();
  await page.unroute(route);
  await card(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(tab(page, 'Rin')).toHaveAttribute('aria-selected', 'true');
  await expect(goal(page)).toBeVisible();
});
