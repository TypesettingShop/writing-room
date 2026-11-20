import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectPageErrors, expect } from './fixtures.js';
import { chooseTheme, colorVariable, openWithThemingFixtures, rgb, workbench } from './themes.helpers.js';

/** The fixture's manifest has two colors that must be refused, with an error each; nothing else may fail. */
const expectedErrors = [
  /contributes\.colors\[2\]\.id: 'configuration\.colors\.id' must only contain letters, digits and dots/,
  /contributes\.colors\[3\]\.defaults\.dark: Expected a hex color/,
];

const test = base.extend<{ unexpectedErrors: void }>({
  unexpectedErrors: [async ({ page }, use) => {
    const collector = collectPageErrors(page);
    try {
      await use();
      expect(collector.errors.filter(error => !expectedErrors.some(pattern => pattern.test(error)))).toEqual([]);
    } finally {
      collector.stop();
    }
  }, { auto: true }],
});

const statusPart = (page: Page) => page.locator('[id="workbench.parts.statusbar"]');

async function open(page: Page): Promise<void> {
  await openWithThemingFixtures(page, ['theme-api/', 'color-theme/']);
  await expect(statusPart(page).locator('[data-entry-id="writing-room-tests.theme-api.kind"]')).toHaveText('Kind 2, changes 0', { timeout: 20_000 });
}

test('a contributed color is a variable with its kind\'s default; a wrong id or default is not', async ({ page }) => {
  await open(page);
  expect(await colorVariable(page, 'themeApi.accent')).toBe('#336699');
  // A default that names another color follows it in the same theme.
  expect(await colorVariable(page, 'themeApi.follow')).toBe('#20334e');
  expect(await colorVariable(page, 'theme-api.dashed')).toBe('');
  expect(await colorVariable(page, 'themeApi.injected')).toBe('');
  expect(await workbench(page).getAttribute('style')).not.toMatch(/display|theme-api-dashed/);

  await chooseTheme(page, 'Writing Room Light');
  expect(await colorVariable(page, 'themeApi.accent')).toBe('#cc6633');
  expect(await colorVariable(page, 'themeApi.follow')).toBe('#cc6633');
  await chooseTheme(page, 'Fixture Contrast');
  expect(await colorVariable(page, 'themeApi.accent')).toBe('#ffff00');
  await chooseTheme(page, 'Fixture Contrast Light');
  expect(await colorVariable(page, 'themeApi.accent')).toBe('#0000aa');
});

test('activeColorTheme has the theme\'s kind, and each change of theme fires once', async ({ page }) => {
  await open(page);
  const kind = statusPart(page).locator('[data-entry-id="writing-room-tests.theme-api.kind"]');
  await chooseTheme(page, 'Writing Room Light');
  await expect(kind).toHaveText('Kind 1, changes 1');
  await chooseTheme(page, 'Fixture Contrast');
  await expect(kind).toHaveText('Kind 3, changes 2');
  await chooseTheme(page, 'Fixture Contrast Light');
  await expect(kind).toHaveText('Kind 4, changes 3');
  await chooseTheme(page, 'Fixture Night');
  await expect(kind).toHaveText('Kind 2, changes 4');
  // Another theme of the same kind is a change too.
  await chooseTheme(page, 'Writing Room Dark');
  await expect(kind).toHaveText('Kind 2, changes 5');
  // Choosing the current theme again changes nothing.
  await chooseTheme(page, 'Writing Room Dark');
  await page.waitForTimeout(300);
  await expect(kind).toHaveText('Kind 2, changes 5');
});

test('status bar items take a hex or theme color, only the allowed backgrounds, and accessibility information', async ({ page }) => {
  await open(page);
  // The error background, with its own foreground over the item's green.
  const build = statusPart(page).getByRole('link', { name: 'Build failed with 3 errors', exact: true });
  await expect(build).toHaveCSS('background-color', rgb('#a1260d'));
  await expect(build).toHaveCSS('color', rgb('#ffffff'));
  await expect(statusPart(page).locator('[data-entry-id="writing-room-tests.theme-api.build"]')).toHaveCount(1);
  // The markdown tooltip is text, never markup.
  await expect(build).toHaveAttribute('title', '**3 errors** <img src="x" onerror="document.title = \'hacked\'">');
  await expect(statusPart(page).locator('img')).toHaveCount(0);

  // A background other than error or warning is not applied; the theme color is.
  const accent = statusPart(page).getByLabel('Accent status', { exact: true });
  await expect(accent).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(accent).toHaveCSS('color', rgb('#336699'));
  await expect(statusPart(page).getByLabel('Hex status', { exact: true })).toHaveCSS('color', rgb('#ff8800'));
  // A color string that is not a hex color stays out of the style.
  const bad = statusPart(page).getByLabel('Bad status', { exact: true });
  await expect(bad).toHaveCSS('color', rgb('#d8e8ff'));
  await expect(bad).toHaveCSS('background-image', 'none');
  expect(await bad.getAttribute('style') ?? '').not.toMatch(/url|red/);

  // A theme color is resolved again when the theme changes.
  await chooseTheme(page, 'Writing Room Light');
  await expect(accent).toHaveCSS('color', rgb('#cc6633'));
  await expect(build).toHaveCSS('background-color', rgb('#c4342d'));

  await build.click();
  await expect(page.getByRole('status').filter({ hasText: 'Theme kind 1' })).toBeVisible();
  expect(await page.title()).not.toBe('hacked');
});
