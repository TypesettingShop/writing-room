import { box, expect, screenshotColors, test } from './fixtures.js';
import { runCommand } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { groups, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
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

function luminance(color: string): number {
  const [red, green, blue] = [1, 3, 5].map(index => {
    const channel = parseInt(color.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const a = luminance(first) + 0.05;
  const b = luminance(second) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}

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

test('nested editor group separators follow the current theme and survive layout restore', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithThemingFixtures(page, ['color-theme/'], JSON.stringify({ 'markdownEditor.contentWidth': 40 }));
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'split.md', '# Editor groups\n\nA centered Markdown document.');
  await treeItem(page, 'split.md').dblclick();
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const editorGroups = groups(page);
  await expect(editorGroups).toHaveCount(2);
  await editorGroups.nth(1).getByRole('textbox', { name: 'Markdown editor' }).click();
  await runCommand(page, 'Split Editor Down', /^View: Split Editor Down$/);
  const markdown = editorGroups.getByRole('textbox', { name: 'Markdown editor' });
  await expect(markdown).toHaveCount(3);
  await markdown.nth(2).click();
  const lowerTab = editorGroups.nth(2).getByRole('tab', { name: 'split.md' });
  await expect(lowerTab).toHaveAttribute('aria-selected', 'true');

  const editor = page.locator('[id="workbench.parts.editor"]');
  const separator = (orientation: string) => editor.locator(
    `.monaco-split-view2.${orientation} > .split-view-container > .split-view-view.visible + .split-view-view.visible`,
  );
  const geometry = () => Promise.all([0, 1, 2].map(index => box(editorGroups.nth(index))));
  const initial = await geometry();
  const [left, topRight, bottomRight] = initial;
  expect(left.x + left.width).toBe(topRight.x);
  expect(topRight.y + topRight.height).toBe(bottomRight.y);
  const splitX = topRight.x;
  const splitY = bottomRight.y;
  const bodyY = Math.floor(topRight.y + topRight.height * 0.65);
  const bodyX = Math.floor(bottomRight.x + bottomRight.width * 0.65);
  const expectSeparators = async (color: string) => {
    await expect.poll(() => separator('horizontal').evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return [style.borderLeftWidth, style.borderLeftColor, style.pointerEvents];
    })).toEqual(['1px', rgb(color), 'none']);
    await expect.poll(() => separator('vertical').evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return [style.borderTopWidth, style.borderTopColor, style.pointerEvents];
    })).toEqual(['1px', rgb(color), 'none']);
  };

  for (const [slug, label, groupBorder, contentBorder, sidebarBorder, tabBorder] of [
    ['dark', 'Writing Room Dark', '#6b7a94', '#313c50', '#313c50', '#90baff'],
    ['light', 'Writing Room Light', '#7b8699', '#d3dae6', '#d3dae6', '#2f6fd6'],
    ['hc-dark', 'Fixture Contrast', '#6fc3df', '#6fc3df', '#6fc3df'],
    ['hc-light', 'Fixture Contrast Light', '#0f4a85', '#0f4a85', '#0f4a85'],
    ['installed', 'Fixture Paper', '#7d412e', '#b09377', '#a0522d'],
  ]) {
    await chooseTheme(page, label);
    await expectSeparators(groupBorder);
    await expect(markdown.nth(1)).toHaveCSS('border-left-color', rgb(contentBorder));
    await expect(markdown.nth(1)).toHaveCSS('border-right-color', rgb(contentBorder));
    await expect.poll(() => sidebarPart(page).evaluate(element => getComputedStyle(element, '::after').borderRightColor))
      .toBe(rgb(sidebarBorder));
    expect(await geometry()).toEqual(initial);
    await page.mouse.move(10, 10);
    const path = testInfo.outputPath(`editor-group-separators-${slug}.png`);
    const screenshot = await page.screenshot({ path, scale: 'css' });
    await testInfo.attach(`editor-group-separators-${slug}`, { path, contentType: 'image/png' });
    if (tabBorder) {
      // The screenshot waits for fonts. Read the centered body's position after any resulting layout.
      const paperBox = await box(markdown.nth(1));
      const tabBox = await box(editorGroups.nth(2).locator('.tab.active'));
      const paperX = Math.round(paperBox.x);
      const tabX = Math.floor(tabBox.x + tabBox.width / 2);
      const [across, down, tabTop, background, tabBar, ...samples] = await screenshotColors(page, screenshot, [
        { x: splitX, y: bodyY },
        { x: bodyX, y: splitY },
        { x: tabX, y: tabBox.y },
        { x: bodyX, y: splitY - 1 },
        { x: bodyX, y: splitY + 1 },
        ...[-1, 0, 1].map(offset => ({ x: paperX + offset, y: bodyY })),
        // One cycle on both sides of the 135° hatch, including its most opaque pixels.
        ...Array.from({ length: 16 }, (_, offset) => [
          { x: splitX - 1, y: bodyY + offset },
          { x: splitX + 1, y: bodyY + offset },
        ]).flat(),
      ]);
      const contentEdge = samples.slice(0, 3);
      const gutters = samples.slice(3);
      expect([across, down, tabTop]).toEqual([groupBorder, groupBorder, tabBorder]);
      expect(contentEdge).toContain(contentBorder);
      const ratios = {
        background: contrast(groupBorder, background),
        tabBar: contrast(groupBorder, tabBar),
        gutter: Math.min(...gutters.map(color => contrast(groupBorder, color))),
      };
      await testInfo.attach(`editor-group-contrast-${slug}`, {
        body: JSON.stringify({ groupBorder, background, tabBar, gutters: [...new Set(gutters)], ratios }, null, 2),
        contentType: 'application/json',
      });
      for (const [surface, ratio] of Object.entries(ratios)) {
        expect(ratio, `${label} ${surface} contrast`).toBeGreaterThanOrEqual(3);
      }
    }
  }

  await page.reload();
  await expect(editorGroups).toHaveCount(3);
  await expectSeparators('#7d412e');
  await expect(markdown.nth(1)).toHaveCSS('border-left-color', rgb('#b09377'));
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
  // The picker starts on the theme on screen, so opening it previews nothing else.
  const input = await openThemePicker(page);
  await expect(page.getByRole('option', { name: /^Writing Room Dark/ })).toHaveAttribute('aria-selected', 'true');
  await expect(statusPart(page)).toHaveCSS('background-color', rgb('#20334e'));
  await input.press('Escape');

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
