import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { getGregorianCalendar } from '../../src/platform/world/common/calendar.js';
import type { WorldCalendarSnapshot } from '../../src/platform/world/common/worldStore.js';

const pane = (page: Page) => page.getByRole('region', { name: 'Calendar', exact: true });
const tab = (page: Page) => page.getByRole('tab', { name: 'Calendar', exact: true });
const rows = (page: Page, list: 'Eras' | 'Months') => pane(page).getByRole('list', { name: list }).getByRole('listitem');

async function commandSearch(page: Page): Promise<void> {
  await page.keyboard.press('F1');
  await page.getByRole('combobox', { name: 'Type a command' }).fill('Edit Calendar');
}

async function openCalendar(page: Page): Promise<void> {
  await commandSearch(page);
  await page.getByRole('option', { name: 'World: Edit Calendar', exact: true }).click();
  await expect(rows(page, 'Months')).toHaveCount(12);
}

async function createWork(request: APIRequestContext, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const response = await request.post('/api/works', { headers, data: { title: 'Calendar acceptance' } });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  const api = `/api/works/${work.id}/world/calendar`;
  return {
    url: '/?work=' + work.id,
    api,
    headers,
    async calendar(): Promise<WorldCalendarSnapshot> {
      const response = await request.get(api);
      expect(response.ok()).toBe(true);
      return response.json();
    },
  };
}

test('opens one calendar tab for the work and restores saved data after reload', async ({ page, request, baseURL }) => {
  await page.goto('/');
  await commandSearch(page);
  await expect(page.getByRole('listbox', { name: 'Results' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'World: Edit Calendar', exact: true })).toHaveCount(0);

  const work = await createWork(request, baseURL!);
  expect(await work.calendar()).toEqual({ calendar: getGregorianCalendar(), revision: 0 });
  await page.goto(work.url);
  await openCalendar(page);
  await openCalendar(page);
  await expect(tab(page)).toHaveCount(1);
  const era = rows(page, 'Eras').nth(1).getByRole('textbox', { name: 'Name' });
  await era.fill('새 서기 ');
  await expect.poll(async () => (await work.calendar()).calendar.eras[1].name).toBe('새 서기');
  await expect(era).toHaveValue('새 서기 ');
  await page.reload();
  await expect(tab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(era).toHaveValue('새 서기');
});

test('holds invalid rows and native preedit, then saves the corrected draft with stable IDs', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await openCalendar(page);
  const months = rows(page, 'Months');
  await pane(page).getByRole('button', { name: 'Add Month' }).press('Enter');
  const added = months.last();
  const name = added.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await name.press('ControlOrMeta+s');
  await expect(added.getByText('The name must have between 1 and 100 characters.')).toBeVisible();
  expect((await work.calendar()).revision).toBe(0);

  await name.dispatchEvent('compositionstart');
  await name.evaluate(input => {
    (input as HTMLInputElement).value = '새 달';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await name.press('ControlOrMeta+s');
  await name.press('Alt+ArrowUp');
  const moved = months.nth(11).getByRole('textbox', { name: 'Name' });
  await expect(moved).toBeFocused();
  await expect(moved).toHaveValue('새 달');
  expect((await work.calendar()).revision).toBe(0);
  await moved.dispatchEvent('compositionend');

  const days = months.nth(11).getByRole('textbox', { name: 'Days' });
  await days.fill('３０');
  await days.press('ControlOrMeta+s');
  await expect.poll(async () => (await work.calendar()).calendar.months[11]).toMatchObject({ name: '새 달', days: 30 });
  const oldId = (await work.calendar()).calendar.months[11].id;
  await months.nth(11).getByRole('button', { name: 'Delete' }).press('Enter');
  await pane(page).getByRole('button', { name: 'Add Month' }).press('Enter');
  await months.last().getByRole('textbox', { name: 'Name' }).fill('새 달');
  await expect.poll(async () => (await work.calendar()).calendar.months.at(-1)?.name).toBe('새 달');
  const replacement = (await work.calendar()).calendar.months.at(-1);
  expect(replacement?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(replacement?.id).not.toBe(oldId);
});

test('keeps a preview date whose era was removed from the draft', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await openCalendar(page);
  const calendar = pane(page);
  const era = calendar.getByRole('combobox', { name: 'Era', exact: true });
  await era.focus();
  await era.press('End');
  const year = calendar.getByRole('textbox', { name: 'Year', exact: true });
  await year.press('2');
  await year.press('0');
  await year.press('2');
  await year.press('4');
  await year.press('Tab');
  const month = calendar.getByRole('combobox', { name: 'Month', exact: true });
  await expect(month).toBeFocused();
  await month.press('ArrowDown');
  await month.press('ArrowDown');
  const day = calendar.getByRole('textbox', { name: 'Day', exact: true });
  await day.fill('29');
  await calendar.getByRole('textbox', { name: 'Hour', exact: true }).fill('14');
  await calendar.getByRole('textbox', { name: 'Minute', exact: true }).fill('30');
  await expect(calendar.getByText('서기 2024년 2월 29일 14:30')).toBeVisible();
  await rows(page, 'Eras').nth(1).getByRole('button', { name: 'Delete' }).click();
  await expect(era).toHaveValue('ad');
  await expect(era.locator('option:checked')).toHaveText('ad (Not in calendar)');
  await expect(calendar.getByText('(확인 필요) ad 2024년 2월 29일 14:30')).toBeVisible();
  await expect(calendar.getByText('This era is not in the calendar.')).toBeVisible();

  await calendar.getByRole('button', { name: 'Use Gregorian Calendar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use Gregorian Calendar', exact: true }).click();
  await expect(calendar.getByText('서기 2024년 2월 29일 14:30')).toBeVisible();
  await expect.poll(async () => (await work.calendar()).calendar.eras.map(era => era.id)).toEqual(['bc', 'ad']);
});

test('retries the first read and asks before closing an invalid draft', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.route(work.api, route => route.fulfill({ status: 503, json: {} }), { times: 1 });
  await page.goto(work.url);
  await commandSearch(page);
  await page.getByRole('option', { name: 'World: Edit Calendar', exact: true }).click();
  await expect(pane(page).getByText('Could not load the calendar.')).toBeVisible();
  await pane(page).getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page, 'Months')).toHaveCount(12);
  const days = rows(page, 'Months').first().getByRole('textbox', { name: 'Days' });
  await days.fill('0');
  await days.press('ControlOrMeta+s');
  await page.getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(pane(page)).toHaveCount(2);
  await expect(pane(page).last().getByRole('textbox', { name: 'Days' }).first()).toHaveValue('0');
  await page.getByRole('button', { name: 'Close Calendar' }).first().click();
  await expect(pane(page)).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Calendar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep Editing', exact: true }).click();
  await expect(days).toHaveValue('0');
  await page.getByRole('button', { name: 'Close Calendar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(tab(page)).toHaveCount(0);
  expect((await work.calendar()).revision).toBe(0);
});

test('asks what to do when a different calendar was saved elsewhere', async ({ page, request, baseURL }) => {
  const work = await createWork(request, baseURL!);
  await page.goto(work.url);
  await openCalendar(page);
  const name = rows(page, 'Months').first().getByRole('textbox', { name: 'Name' });
  const saved = await work.calendar();
  saved.calendar.months[0].name = '다른 창';
  const response = await request.put(work.api, {
    headers: work.headers, data: { calendar: saved.calendar, expectedRevision: saved.revision },
  });
  expect(response.ok()).toBe(true);

  await name.fill('내 초안');
  await name.press('ControlOrMeta+s');
  const conflict = page.getByRole('dialog');
  await conflict.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(name).toHaveValue('다른 창');
  expect((await work.calendar()).calendar.months[0].name).toBe('다른 창');
});
