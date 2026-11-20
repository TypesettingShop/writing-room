import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { expect } from './fixtures.js';

const manifest = JSON.parse(readFileSync(
  new URL('../fixtures/extensions/window-ui/package.json', import.meta.url), 'utf8')) as IExtensionManifest;

/** Installs the window UI fixture before the workbench starts, then opens the app. */
export async function openWindowUiFixture(page: Page): Promise<void> {
  await seedInstalledExtensions(page, [{ location: extensionFixtureLocation('window-ui'), manifest }]);
  await page.goto('/');
}

/** Lets the workbench start normally, then pauses time before any test toasts arrive. */
export async function openWindowUiFixtureWithPausedClock(page: Page): Promise<void> {
  const start = Date.now();
  await page.clock.install({ time: start });
  await openWindowUiFixture(page);
  await expect(page.getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await page.clock.pauseAt(start + 60_000);
}

/** Runs a command from the palette with the keyboard, so focus goes back where it was before it runs. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const palette = page.getByRole('combobox', { name: 'Type a command' });
  await palette.fill(title);
  await expect(page.getByRole('option', { name: title, exact: true })).toHaveAttribute('aria-selected', 'true');
  await palette.press('Enter');
}

export const message = (page: Page, text: string): Locator => page.getByRole('status').filter({ hasText: text });

export async function dismissAllToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss message', exact: true });
  while (await dismiss.count()) {
    await dismiss.first().press('Enter');
  }
}

const panelPart = (page: Page): Locator => page.locator('[id="workbench.parts.panel"]');

/** The Output view's parts, in the panel. */
export function outputView(page: Page) {
  const panel = panelPart(page);
  return {
    panel,
    tab: panel.getByRole('tab', { name: 'Output' }),
    channels: panel.getByRole('listbox', { name: 'Output Channels' }),
    log: panel.getByRole('log', { name: 'Output' }),
  };
}
