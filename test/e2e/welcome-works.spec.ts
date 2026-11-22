import { runCommand } from './configuration.helpers.js';
import { expect, test } from './fixtures.js';

test('shows recent Works as text and opens the full list from More', async ({ page }) => {
  const entries = Array.from({ length: 21 }, (_, index) => ({
    id: '12345678-abcd-4000-8000-' + String(index).padStart(12, '0'),
    title: index === 20 ? '<img src=x>' : 'Welcome fixture ' + index,
    createdAt: 0,
    updatedAt: index,
  }));
  await page.route('**/api/works', route => route.fulfill({ json: { works: entries } }));
  await page.goto('/?keep=a%20b#works');
  const works = page.getByRole('region', { name: 'Works', exact: true });
  await expect(works).toBeFocused();
  await expect(page).toHaveURL('/?keep=a%20b');
  await expect(works.locator('li button')).toHaveCount(21);
  await expect(works.locator('li button').first()).toHaveText('<img src=x>');
  await expect(works.locator('img')).toHaveCount(0);
  await expect(works.getByRole('button', { name: 'Welcome fixture 0', exact: true })).toHaveCount(0);
  await works.getByRole('button', { name: 'More...' }).click();
  await expect(page.getByRole('option', { name: /^Welcome fixture 0 / })).toBeVisible();
});

test('reads Works again after 30 seconds when focus returns', async ({ page }) => {
  const now = Date.now();
  await page.clock.setFixedTime(now);
  let reads = 0;
  await page.route('**/api/works', route => {
    reads++;
    return route.fulfill({ json: { works: [] } });
  });
  await page.goto('/');
  const works = page.getByRole('region', { name: 'Works', exact: true });
  await expect(works.getByText('No Works yet.')).toBeVisible();
  expect(reads).toBe(1);

  const refocus = async (elapsed: number) => {
    await page.clock.setFixedTime(now + elapsed);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  };
  await refocus(29_999);
  expect(reads).toBe(1);
  await refocus(30_000);
  await expect.poll(() => reads).toBe(2);
});

test('consumes #works and activates an existing Welcome even with restored editor state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await runCommand(page, 'New Untitled Text File', /^File: New Untitled Text File$/);
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toHaveAttribute('aria-selected', 'true');
  await page.goto('about:blank');
  await page.goto('/#works');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('region', { name: 'Works', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Welcome' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toBeVisible();
});

test('shows the unavailable state when the web host serves no Works API', async ({ page }) => {
  await page.route('**/api/works', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Writing Room</title>',
  }));
  await page.goto('/');
  const works = page.getByRole('region', { name: 'Works', exact: true });
  await expect(works.getByText('The Works server is not available.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
});
