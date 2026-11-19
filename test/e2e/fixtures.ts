import { expect, test as base } from '@playwright/test';
import type { ConsoleMessage, Locator, Page } from '@playwright/test';

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

/** A locator's bounding box, which it must have. */
export async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

/** Presses the mouse at (x, y), moves it to (toX, toY) in steps, and lets go. */
export async function drag(page: Page, x: number, y: number, toX: number, toY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 8 });
  await page.mouse.up();
}

/** The text Monaco renders in `pane`, one line per visible line, with its non-breaking spaces made plain. */
export async function renderedText(pane: Locator): Promise<string> {
  // An editor without a model renders no lines at all.
  const lines = pane.locator('.monaco-editor .view-lines');
  const text = await lines.count() ? await lines.first().innerText() : '';
  return text.replaceAll('\u00a0', ' ');
}

export { expect };
