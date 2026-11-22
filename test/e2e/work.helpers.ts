import { expect, type APIRequestContext, type Page } from '@playwright/test';

export async function createWorkForTest(request: APIRequestContext, baseURL: string, title: string): Promise<string> {
  const response = await request.post('/api/works', {
    headers: { Origin: new URL(baseURL).origin }, data: { title },
  });
  expect(response.status()).toBe(201);
  const { work } = await response.json();
  return work.id;
}

export async function showPracticeExplorer(page: Page): Promise<void> {
  const explorer = page.getByRole('button', { name: 'Explorer', exact: true });
  if (await explorer.getAttribute('aria-pressed') !== 'true') {
    await explorer.click();
  }
}
