import { expect, test as base } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/** Collects a page's uncaught errors and console errors until `stop` is called. */
export function collectPageErrors(page: Page): { readonly errors: readonly string[]; stop(): void } {
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.stack ?? error.message);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  };

  page.on('pageerror', onError);
  page.on('console', onConsole);
  return {
    errors,
    stop: () => {
      page.off('pageerror', onError);
      page.off('console', onConsole);
    },
  };
}

export const test = base.extend<{ appPage: Page; pageErrors: readonly string[] }>({
  pageErrors: [async ({ page }, use) => {
    const collector = collectPageErrors(page);
    try {
      await use(collector.errors);
      expect(collector.errors, 'Browser page errors and console errors').toEqual([]);
    } finally {
      collector.stop();
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
