import { expect, test } from './fixtures.js';
import {
  chooseTheme, colorVariable, editorBackground, kindClass, newUntitled, openThemePicker, openWithThemingFixtures,
  persistedSettings, recordRequests, rgb, themingFixtureLocation, workbench,
} from './themes.helpers.js';

/** What v0.1.0 drew: the variables workbench.css set and the fallbacks of the stylesheets that read the others. */
const V010_COLORS: Readonly<Record<string, string>> = {
  'editor.background': '#171b24', 'editor.foreground': '#d7dfec', 'titleBar.activeBackground': '#232b39',
  'titleBar.activeForeground': '#eaf0f9', 'activityBar.background': '#1a202c', 'activityBar.foreground': '#a5b3c8',
  'activityBar.activeBorder': '#90baff', 'sideBar.background': '#202735', 'sideBar.foreground': '#d1daea',
  'sideBarSectionHeader.background': '#262f40', 'panel.background': '#181d27', 'panel.border': '#313c50',
  'panelTitle.activeBorder': '#90baff', 'statusBar.background': '#20334e', 'statusBar.foreground': '#d8e8ff',
  'menu.background': '#232c3d', 'menu.foreground': '#e0e8f6', 'menu.selectionBackground': '#364663',
  'menu.border': '#465672', 'focusBorder': '#9dc3ff', 'sash.hoverBorder': '#78aaff',
  'list.activeSelectionBackground': '#04395e', 'list.hoverBackground': '#ffffff12', 'input.background': '#3c3c3c',
  'editorGroupHeader.tabsBackground': '#1c212c', 'tab.inactiveForeground': '#8b97ab', 'tab.border': '#252c3a',
  'tab.activeBackground': '#171b24', 'editorGroup.dropBackground': '#53595d80', 'textLink.foreground': '#7fb2ff',
};

const paper = { editor: '#f5f0e6', sideBar: '#efe7d8', statusBar: '#d9c9a8' };
const statusPart = (page: import('@playwright/test').Page) => page.locator('[id="workbench.parts.statusbar"]');
const sidebarPart = (page: import('@playwright/test').Page) => page.locator('[id="workbench.parts.sidebar"]');

test('the default theme is v0.1.0\'s: the same variables, Monaco\'s vs-dark, a dark color scheme', async ({ appPage: page }) => {
  for (const [id, value] of Object.entries(V010_COLORS)) {
    expect(await colorVariable(page, id), id).toBe(value);
  }
  expect(await kindClass(page)).toBe('vs-dark');
  await expect(workbench(page)).toHaveCSS('color-scheme', 'dark');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#20334e'));
  await expect(page.locator('.workbench-title .codicon').first()).toHaveCSS('color', rgb('#a9caff'));
  await newUntitled(page);
  expect(await editorBackground(page)).toBe(rgb('#1e1e1e'));
});

test('arrows preview a theme without writing the setting, and Escape goes back', async ({ page }) => {
  await openWithThemingFixtures(page, ['color-theme/']);
  await newUntitled(page);
  const before = await persistedSettings(page);
  const input = await openThemePicker(page);
  await expect(page.getByRole('option', { name: /^Writing Room Dark/ })).toHaveAttribute('aria-selected', 'true');
  // Dark themes are sorted by label: the one above the current theme is Fixture Night.
  await input.press('ArrowUp');
  await expect(page.getByRole('option', { name: /^Fixture Night/ })).toHaveAttribute('aria-selected', 'true');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#1b2a52'));
  expect(await persistedSettings(page)).toBe(before);
  // Typing moves the highlight to the first match, which shows too.
  await input.fill('Paper');
  await expect(page.getByRole('option', { name: /^Fixture Paper/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => colorVariable(page, 'editor.background')).toBe(paper.editor);
  expect(await kindClass(page)).toBe('vs');
  await expect.poll(() => editorBackground(page)).toBe(rgb(paper.editor));
  expect(await persistedSettings(page)).toBe(before);

  await input.press('Escape');
  await expect.poll(() => colorVariable(page, 'editor.background')).toBe('#171b24');
  expect(await kindClass(page)).toBe('vs-dark');
  await expect.poll(() => editorBackground(page)).toBe(rgb('#1e1e1e'));
  expect(await persistedSettings(page)).toBe(before);
});

test('a chosen extension theme colors the workbench and Monaco, and stays after a reload', async ({ page }) => {
  await openWithThemingFixtures(page, ['color-theme/']);
  await newUntitled(page);
  await chooseTheme(page, 'Fixture Paper');
  await expect(sidebarPart(page)).toHaveCSS('background-color', rgb(paper.sideBar));
  await expect(statusPart(page)).toHaveCSS('background-color', rgb(paper.statusBar));
  expect(await kindClass(page)).toBe('vs');
  await expect(workbench(page)).toHaveCSS('color-scheme', 'light');
  // From the included file, which the theme's own file does not override.
  expect(await colorVariable(page, 'panel.background')).toBe('#ece4d4');
  // An id nothing registered is a variable too.
  expect(await colorVariable(page, 'fixtureTheme.accent')).toBe('#a0522d');
  await expect.poll(() => editorBackground(page)).toBe(rgb(paper.editor));
  expect(JSON.parse((await persistedSettings(page))!)).toEqual({ 'workbench.colorTheme': 'Fixture Paper' });

  await page.reload();
  await expect(statusPart(page)).toHaveCSS('background-color', rgb(paper.statusBar));
  expect(await kindClass(page)).toBe('vs');
  await newUntitled(page);
  await expect.poll(() => editorBackground(page)).toBe(rgb(paper.editor));
});

test('an id given in the manifest is the setting\'s value; the built-in light theme is light', async ({ page }) => {
  await openWithThemingFixtures(page, ['color-theme/']);
  await chooseTheme(page, 'Fixture Night');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#1b2a52'));
  expect(JSON.parse((await persistedSettings(page))!)).toEqual({ 'workbench.colorTheme': 'fixture-night' });
  expect(await kindClass(page)).toBe('vs-dark');

  await chooseTheme(page, 'Fixture Contrast');
  expect(await kindClass(page)).toBe('hc-black');

  await chooseTheme(page, 'Writing Room Light');
  expect(await kindClass(page)).toBe('vs');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#dde8f8'));
  await newUntitled(page);
  await expect.poll(() => editorBackground(page)).toBe(rgb('#fbfcfe'));
});

test('removing the theme\'s extension falls back and keeps the setting; installing it again brings the theme back', async ({ page }) => {
  const settings = '{\n  // chosen\n  "workbench.colorTheme": "Fixture Paper"\n}\n';
  await openWithThemingFixtures(page, ['color-theme/'], settings);
  await expect(statusPart(page)).toHaveCSS('background-color', rgb(paper.statusBar));

  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Uninstall Extension');
  await page.getByRole('option', { name: /^Uninstall Extension/ }).click();
  await page.getByRole('option', { name: /Theming Fixture Themes/ }).click();
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#20334e'));
  expect(await kindClass(page)).toBe('vs-dark');
  expect(await persistedSettings(page)).toBe(settings);

  await page.reload();
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#20334e'));
  expect(await persistedSettings(page)).toBe(settings);

  await page.keyboard.press('F1');
  await page.getByRole('combobox').fill('Install Extension from Location');
  await page.getByRole('option', { name: /Install Extension from Location/ }).click();
  const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
  await location.fill(themingFixtureLocation('color-theme/'));
  await location.press('Enter');
  await page.getByRole('option', { name: /Install Theming Fixture Themes/ }).click();
  await expect(statusPart(page)).toHaveCSS('background-color', rgb(paper.statusBar));
  expect(await kindClass(page)).toBe('vs');
});

test('values that are not colors stay out; paths and includes outside the extension are never read', async ({ page }) => {
  const outside = recordRequests(page, /\/theming\/outside-theme\.json/);
  const cycle = recordRequests(page, /\/color-theme\/themes\/cycle\.json/);
  await openWithThemingFixtures(page, ['color-theme/']);
  const input = await openThemePicker(page);
  await input.fill('Fixture');
  await expect(page.getByRole('option', { name: /^Fixture Hostile/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Fixture (Escape|Plist)/ })).toHaveCount(0);
  await input.press('Escape');

  await chooseTheme(page, 'Fixture Hostile');
  await expect(sidebarPart(page)).toHaveCSS('background-color', rgb('#123456'));
  expect(await colorVariable(page, 'editor.background')).toBe('#171b24');
  expect(await colorVariable(page, 'statusBar.background')).toBe('#20334e');
  expect(await colorVariable(page, 'panel.background')).toBe('#181d27');
  expect(await workbench(page).getAttribute('style')).not.toMatch(/url\(|rgb\(|display|example\.invalid/);
  await expect(page.locator('body')).toBeVisible();

  await chooseTheme(page, 'Fixture Cycle');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#3a0050'));
  // The file and five includes of itself, then the depth limit.
  expect(cycle).toHaveLength(6);
  expect(outside).toEqual([]);
});
