import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Navigator acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  return { url: '/?work=' + work.id, nodes: '/api/works/' + work.id + '/nodes', headers };
}

const navigator = (page: Page) => page.getByRole('region', { name: 'Navigator', exact: true });
const tree = (page: Page) => navigator(page).getByRole('tree');
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const title = (page: Page) => tree(page).getByRole('textbox', { name: 'Title', exact: true });
const toolbar = (page: Page, name: string) => navigator(page).locator('header').getByRole('button', { name, exact: true });

async function create(page: Page, command: string, name: string): Promise<void> {
  await toolbar(page, command).click();
  await title(page).fill(name);
  await title(page).press('Enter');
  await expect(title(page)).toHaveCount(0);
}

test('shows Navigator only in a work and remembers folder, expansion and selection', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Explorer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manuscript', exact: true })).toHaveCount(0);

  const { url } = await createWork(request, baseURL!);
  await page.goto(url);
  await expect(navigator(page)).toBeVisible();
  await create(page, 'New Part', 'Opening');
  await create(page, 'New Chapter', 'First');
  await row(page, '1부 - Opening').click();
  await create(page, 'New Chapter', 'Second');
  await create(page, 'New Part', 'Ending');
  await create(page, 'New Chapter', 'Again');
  await expect(row(page, '1장 - Again')).toBeVisible();
  await expect(row(page, '2장 - Second').locator('.manuscript-twig')).toHaveText('└─');
  await expect(row(page, '1장 - First').locator('.manuscript-twig')).toHaveText('├─');

  await row(page, '2부 - Ending').getByRole('button', { name: 'Collapse' }).dblclick();
  await expect(row(page, '2부 - Ending')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'Parent Folder')).toHaveCount(0);
  await row(page, '1부 - Opening').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(row(page, '2부 - Ending')).toHaveCount(0);
  await row(page, '1장 - First').click();
  await tree(page).press('ArrowRight');
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, '1장 - First')).toHaveAttribute('aria-selected', 'true');
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await row(page, '1장 - First').getAttribute('id'))!);
  await tree(page).press('Enter');
  await expect(row(page, '2장 - Second')).toHaveCount(0);
  await row(page, 'Parent Folder').click();
  await expect(row(page, '2장 - Second')).toBeVisible();
  await tree(page).press('Backspace');
  await expect(row(page, '2부 - Ending')).toBeVisible();
});

test('keeps inline rename local until Enter and refreshes after a revision conflict', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const added = await request.post(work.nodes, { headers: work.headers, data: { kind: 'part', parentId: null, title: 'Original', expectedRevision: 0 } });
  expect(added.status()).toBe(201);
  const { node } = await added.json();
  await page.goto(work.url);
  await row(page, '1부 - Original').dblclick();
  await expect(row(page, 'Parent Folder')).toBeVisible();
  await tree(page).press('Backspace');
  await tree(page).press('F2');
  await title(page).fill('Do not save');
  await title(page).press('Backspace');
  await expect(title(page)).toHaveValue('Do not sav');
  await title(page).press('Escape');
  await expect(row(page, '1부 - Original')).toBeVisible();
  await tree(page).press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row(page, '1부 - Original')).toBeVisible();

  await row(page, '1부 - Original').click();
  await tree(page).press('F2');
  await title(page).fill('My title');
  expect((await request.patch(work.nodes + '/' + node.id, {
    headers: work.headers, data: { title: 'Other tab', expectedRevision: 1 },
  })).ok()).toBe(true);
  await title(page).press('Enter');
  await expect(page.getByText('The manuscript changed elsewhere. It has been reloaded.')).toBeVisible();
  await expect(row(page, '1부 - Other tab')).toBeVisible();
  await expect(title(page)).toHaveValue('My title');
  await title(page).press('Enter');
  await expect(row(page, '1부 - My title')).toBeVisible();
});

test('renders only the visible window of a 10,000-row manuscript tree', async ({ page, request, baseURL }) => {
  const { url } = await createWork(request, baseURL!);
  const count = 10_000;
  await page.route('**/api/works/*/tree', route => route.fulfill({
    json: {
      revision: 1,
      nodes: Array.from({ length: count }, (_, position) => ({
        id: '00000000-0000-0000-0000-' + position.toString(16).padStart(12, '0'),
        parentId: null, kind: 'document', title: 'Document ' + (position + 1), position,
        metadata: {}, createdAt: 1, updatedAt: 1,
      })),
    },
  }));
  await page.goto(url);
  await expect(row(page, 'Document 1')).toBeVisible();
  const viewport = await tree(page).evaluate(element => Math.ceil(element.clientHeight / 24));
  await tree(page).press('End');
  const last = row(page, 'Document ' + count);
  await expect(last).toBeVisible();
  await expect(tree(page)).toBeFocused();
  await expect(tree(page)).toHaveAttribute('aria-activedescendant', (await last.getAttribute('id'))!);
  expect(await tree(page).getByRole('treeitem').count()).toBeLessThanOrEqual(viewport + 17);
  await expect(row(page, 'Document 1')).toHaveCount(0);
});

test('opens a document once and keeps the title and path current in its editor tab', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  const add = async (kind: string, name: string, expectedRevision: number, parentId: string | null) => {
    const response = await request.post(work.nodes, {
      headers: work.headers, data: { kind, title: name, parentId, expectedRevision },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).node.id as string;
  };
  const part = await add('part', 'Opening', 0, null);
  const chapter = await add('chapter', 'First', 1, part);
  await add('document', 'Scene', 2, chapter);
  await add('document', 'Next scene', 3, chapter);
  await page.goto(work.url);
  await row(page, '1부 - Opening').getByRole('button', { name: 'Expand' }).click();
  await row(page, '1장 - First').getByRole('button', { name: 'Expand' }).click();
  await row(page, 'Scene').click();
  await expect(page.getByRole('tab', { name: 'Scene', exact: true })).toHaveCount(0);
  await tree(page).press('Enter');
  const tab = page.getByRole('tab', { name: 'Scene', exact: true });
  await expect(page.locator('.tab').filter({ has: tab })).toHaveAttribute('title', '1부 - Opening / 1장 - First / Scene');
  await row(page, 'Scene').dblclick();
  await expect(tab).toHaveCount(1);
  await row(page, '1장 - First').click();
  await tree(page).press('F2');
  await title(page).fill('Revised');
  await title(page).press('Enter');
  await expect(page.locator('.tab').filter({ has: tab })).toHaveAttribute('title', '1부 - Opening / 1장 - Revised / Scene');
  await row(page, '1장 - Revised').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open All Documents', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Next scene', exact: true })).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});
