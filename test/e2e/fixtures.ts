import { expect, test as base } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

export const test = base.extend<{ appPage: Page; pageErrors: readonly string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.stack ?? error.message);
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    };

    page.on('pageerror', onError);
    page.on('console', onConsole);
    try {
      await use(errors);
      expect(errors, 'Browser page errors and console errors').toEqual([]);
    } finally {
      page.off('pageerror', onError);
      page.off('console', onConsole);
    }
  }, { auto: true }],

  appPage: async ({ page, pageErrors }, use) => {
    const response = await page.goto('/');
    expect(response?.ok()).toBe(true);
    expect(pageErrors).toEqual([]);
    await use(page);
  },
});

export { expect };
