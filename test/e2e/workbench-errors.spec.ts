import { collectPageErrors, expect, test as workbenchTest } from './fixtures.js';

const test = workbenchTest.extend({
  pageErrors: async ({ page }, use) => {
    const collector = collectPageErrors(page);
    try {
      await use(collector.errors);
    } finally {
      collector.stop();
    }
  },
});

test('suppresses only cancellation errors from unhandled rejections', async ({ page, pageErrors }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('menubar')).toBeVisible();

  await page.evaluate(async () => {
    const cancellation = Object.assign(new Error('Canceled'), { name: 'Canceled' });
    // Wait for the event itself before checking the browser's default reporting.
    const delivered = new Promise<void>(resolve => {
      // Another rejection arriving first must not take the listener away.
      const onRejection = (event: PromiseRejectionEvent) => {
        if (event.reason === cancellation) {
          window.removeEventListener('unhandledrejection', onRejection);
          resolve();
        }
      };
      window.addEventListener('unhandledrejection', onRejection);
    });
    void Promise.reject(cancellation);
    await delivered;
  });

  const ordinary = page.waitForEvent('pageerror');
  await page.evaluate(() => { void Promise.reject(new Error('boom')); });
  expect((await ordinary).message).toContain('boom');
  expect(pageErrors.some(error => error.includes('Canceled'))).toBe(false);

  const object = page.waitForEvent('pageerror');
  await page.evaluate(() => { void Promise.reject({ name: 'Canceled', message: 'Canceled' }); });
  expect((await object).message).toMatch(/Canceled|Object/);
});
