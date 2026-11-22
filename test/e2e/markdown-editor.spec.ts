import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { box, drag, expect, test } from './fixtures.js';
import {
  openSettings, persistedSettings, replaceText, runCommand, saveSettings, settingsKey, startWithMarkdownSource,
} from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { groups, listBackups, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { chooseTheme, kindClass, openWithThemingFixtures } from './themes.helpers.js';

const richEditor = (scope: Locator) => scope.getByRole('textbox', { name: 'Markdown editor' });
const markdownFontEntry = /\/markdownEditorFonts(?:-[\w-]+\.css|\.ts)(?:\?.*)?$/;

async function openMarkdown(page: Page, name: string, text: string): Promise<Locator> {
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, text);
  await treeItem(page, name).dblclick();
  return groups(page).first();
}

async function openTypewriterMarkdown(page: Page, name: string, text: string): Promise<Locator> {
  await page.addInitScript(key => {
    localStorage.setItem('writing-room:storage:version', '2');
    localStorage.setItem(key, JSON.stringify({ 'markdownEditor.typewriterScroll': true }));
  }, settingsKey);
  await page.goto('/');
  return openMarkdown(page, name, text);
}

test('opens Markdown from Explorer and carries its draft and saved text through reloads', async ({ appPage: page }) => {
  const name = 'draft.markdown';
  const group = await openMarkdown(page, name, 'First\n=====\n\nHello\n');
  const editor = richEditor(group);
  await expect(editor.getByRole('heading', { name: 'First' })).toBeVisible({ timeout: 20_000 });
  await expect(selectedTab(group)).toHaveText(name);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  await expect(editor.locator('p')).toHaveText('Hello world', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  expect(await readWorkspaceText(page, name)).toBe('First\n=====\n\nHello\n');

  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('First\n=====\n\nHello world\n');
  await page.reload();
  await expect(editor.locator('p')).toHaveText('Hello world', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('switches the active tab in place, keeps its draft and takes the caret near the same block', async ({ appPage: page }) => {
  const name = 'switch.md';
  const group = await openMarkdown(page, name, '# Heading\n\nFirst paragraph\n\nSecond paragraph\n');
  const editor = richEditor(group);
  await editor.getByText('Second paragraph').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' draft');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  const tabs = await group.getByRole('tab').allTextContents();
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type(' edit');
  await treeItem(page, name).dblclick();
  await expect(group.locator('.view-lines')).toContainText('Second paragraph draft edit');
  await expect(group.getByRole('tab')).toHaveText(tabs);
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await expect.poll(() => listBackups(page)).toHaveLength(1);

  await page.reload();
  await expect(group.locator('.view-lines')).toContainText('Second paragraph draft edit', { timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');

  await runCommand(page, 'Toggle Source Mode', /Markdown: Toggle Source Mode/);
  await expect(editor.getByText('Second paragraph draft edit')).toBeVisible();
  await expect(group.getByRole('tab')).toHaveText(tabs);
});

test('honors the Source default and still allows explicit WYSIWYG', async ({ page }) => {
  await startWithMarkdownSource(page);
  await page.goto('/');
  const group = await openMarkdown(page, 'source.md', '# Heading');
  await expect(group.locator('.view-lines')).toContainText('# Heading', { timeout: 20_000 });
  await group.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await expect(richEditor(group).getByRole('heading', { name: 'Heading' })).toBeVisible();
});

test('keeps Source mode available while rich Markdown is loading and after the read fails', async ({ appPage: page }) => {
  const name = 'read-retry.md';
  const source = '# Retry the Markdown file in source mode';
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, source);
  await page.evaluate(length => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this.size !== length) {
        return read.call(this);
      }
      Blob.prototype.arrayBuffer = read;
      return new Promise((_resolve, reject) => {
        window.addEventListener('test-reject-markdown-read', () => reject(new Error('Test read failure')), { once: true });
        document.documentElement.dataset.testMarkdownRead = 'pending';
      });
    };
  }, source.length);

  await treeItem(page, name).dblclick();
  const group = groups(page).first();
  const sourceButton = group.getByRole('button', { name: 'Switch to Markdown Source' });
  await expect(page.locator('html')).toHaveAttribute('data-test-markdown-read', 'pending');
  await expect(richEditor(group)).toBeHidden();
  await expect(sourceButton).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('test-reject-markdown-read')));

  const error = group.getByRole('alert').filter({ hasText: name });
  await expect(error).toBeVisible();
  await expect(sourceButton).toBeVisible();
  await error.focus();
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await expect(group.getByRole('button', { name: 'Switch to WYSIWYG' })).toBeVisible();
  await expect(group.locator('.view-lines')).toContainText(source);
});

test('applies a shared Markdown content width on Enter and blur and restores it after reload', async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem('writing-room:storage:version', '2');
      localStorage.setItem(key, JSON.stringify({ 'markdownEditor.contentWidth': '60' }));
    }
  }, settingsKey);
  await page.goto('/');
  const name = 'content-width.md';
  const group = await openMarkdown(page, name, 'Shared width');
  const left = richEditor(group);
  const maxLineWidth = (editor: Locator) => editor.evaluate(element => {
    const style = getComputedStyle(element);
    return Number.parseFloat(style.maxWidth) - [
      style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth,
    ].reduce((sum, length) => sum + Number.parseFloat(length), 0);
  });
  const widthInput = (scope: Locator) => scope.getByRole('spinbutton', { name: 'Content Width (characters)' });
  await expect(widthInput(group)).toHaveValue('80', { timeout: 20_000 });
  const expectedWidth = await left.evaluate(element => {
    const probe = element.ownerDocument.createElement('div');
    probe.style.cssText = 'position: absolute; visibility: hidden; width: 80ch';
    const { fontFamily, fontSize, fontWeight, fontStyle } = getComputedStyle(element);
    Object.assign(probe.style, { fontFamily, fontSize, fontWeight, fontStyle });
    element.after(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });
  expect((await box(left.locator('p'))).width).toBeCloseTo(expectedWidth, 1);
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const rightGroup = groups(page).nth(1);
  const right = richEditor(rightGroup);
  const input = widthInput(rightGroup);
  await expect(input).toHaveValue('80');
  await input.fill('60');
  await input.press('Enter');
  await expect(widthInput(group)).toHaveValue('60');
  await input.press('Shift+Tab');
  await expect(rightGroup.getByRole('toolbar', { name: 'Markdown formatting' }).locator('button[tabindex="0"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  expect(await maxLineWidth(left)).toBeCloseTo(expectedWidth * 0.75, 1);
  expect(await maxLineWidth(right)).toBe(await maxLineWidth(left));
  for (const invalid of ['0', '-30', '60.5', '401', '']) {
    await input.fill(invalid);
    await input.press('Enter');
    await expect(input).toHaveValue('60');
  }
  await input.fill('72');
  await right.click();
  await expect(input).toHaveValue('72');
  await expect(widthInput(group)).toHaveValue('72');
  expect(await persistedSettings(page)).toMatch(/"markdownEditor\.contentWidth":\s*72/);
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('Shared width');
  await page.reload();
  await expect(widthInput(group)).toHaveValue('72', { timeout: 20_000 });
  await expect(input).toHaveValue('72');
});

test('fills the editor, saves its layout, and keeps the independent Focus Mode width', async ({ appPage: page }) => {
  const name = 'content-layout.md';
  const group = await openMarkdown(page, name, 'Centered text');
  const editor = richEditor(group);
  const width = group.getByRole('spinbutton', { name: 'Content Width (characters)' });
  const center = group.getByRole('button', { name: 'Center Content' });
  const fill = group.getByRole('button', { name: 'Fill Editor Width' });
  await expect(center).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  const centered = (await box(editor)).width;
  await fill.click();
  await expect(fill).toHaveAttribute('aria-pressed', 'true');
  await expect(center).toHaveAttribute('aria-pressed', 'false');
  await expect(width).toBeDisabled();
  await expect(editor).toHaveCSS('max-width', 'none');
  await expect(group.locator('.markdown-editor-surface')).toHaveCSS('background-image', 'none');
  await expect(editor).toHaveCSS('border-left-width', '0px');
  expect((await box(editor)).width).toBeGreaterThan(centered);
  expect(await persistedSettings(page)).toMatch(/"markdownEditor\.contentLayout":\s*"fill"/);
  await page.reload();
  await expect(fill).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await expect(width).toBeDisabled();
  await runCommand(page, 'Toggle Focus Mode', /^Markdown: Toggle Focus Mode$/);
  await expect(editor).not.toHaveCSS('max-width', 'none');
  expect((await box(editor)).width).toBeLessThan(centered);
  await editor.press('Escape');
  await expect(editor).toHaveCSS('max-width', 'none');
  await runCommand(page, 'Center Content', /^Markdown: Center Content$/);
  await expect(center).toHaveAttribute('aria-pressed', 'true');
  await expect(width).toBeEnabled();
  expect((await box(editor)).width).toBe(centered);
  expect(await readWorkspaceText(page, name)).toBe('Centered text');
});

for (const [theme, kind] of [
  ['Writing Room Light', 'vs'], ['Writing Room Dark', 'vs-dark'],
  ['Fixture Contrast Light', 'hc-light'], ['Fixture Contrast', 'hc-black'],
]) {
  test(`uses visible Markdown gutters in ${theme}`, async ({ page }) => {
    await openWithThemingFixtures(page, ['color-theme/'], JSON.stringify({ 'workbench.colorTheme': theme }));
    const group = await openMarkdown(page, 'gutters-theme.md', 'Themed gutter');
    const editor = richEditor(group);
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => kindClass(page)).toBe(kind);
    await expect(group.locator('.markdown-editor-surface')).toHaveCSS('background-image', /repeating-linear-gradient\(135deg, /);
    await expect(editor).toHaveCSS('border-left-width', '1px');
    await expect(editor).toHaveCSS('border-right-width', '1px');
    await expect(editor).not.toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
    await expect(editor).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
}

test('starts typing at the clicked gutter’s line edge or document end', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'gutters.md',
    'First paragraph\n\nSecond paragraph {.right}\n\n- First item\n- Last item');
  const editor = richEditor(group);
  const second = editor.locator('p').nth(1);
  await expect(second).toBeVisible({ timeout: 20_000 });
  const paper = await box(editor);
  const line = await box(second);
  await page.mouse.click(paper.x - 12, line.y + line.height / 2);
  await expect(editor).toBeFocused();
  await page.keyboard.type('Start ');
  await expect(second).toHaveText('Start Second paragraph');
  await page.mouse.click(paper.x + paper.width + 12, line.y + line.height / 2);
  await page.keyboard.type(' end');
  await expect(second).toHaveText('Start Second paragraph end');
  const lastItem = editor.locator('li').last();
  const last = await box(lastItem);
  await page.mouse.click(paper.x - 12, last.y + last.height / 2);
  await page.keyboard.type('Start ');
  await expect(lastItem).toHaveText('Start Last item');
  await page.mouse.click(paper.x - 12, last.y + last.height + 35);
  await page.keyboard.type(' below');
  await expect(lastItem).toHaveText('Start Last item below');
  // Shift extends from the caret, here at the document end, to the clicked line's start.
  await page.keyboard.down('Shift');
  await page.mouse.click(paper.x - 12, line.y + line.height / 2);
  await page.keyboard.up('Shift');
  await page.keyboard.type('Replaced');
  await expect(second).toHaveText('Replaced');
  await expect(editor.locator('li')).toHaveCount(0);
});

test('keeps split source and WYSIWYG views synchronized on one dirty model', async ({ appPage: page }) => {
  const name = 'split.md';
  const left = await openMarkdown(page, name, '# Heading\n\nShared');
  await expect(richEditor(left).getByText('Shared')).toBeVisible({ timeout: 20_000 });
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const right = groups(page).nth(1);
  await expect(richEditor(right).getByText('Shared')).toBeVisible();
  await right.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(right.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' source');
  await expect(richEditor(left).getByText('Shared source')).toBeVisible();
  await expect(selectedTab(left)).toHaveAccessibleDescription('Modified');

  await richEditor(left).getByText('Shared source').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' rich');
  await expect(right.locator('.view-lines')).toContainText('Shared source rich');
  await left.getByRole('button', { name: 'Close split.md' }).click();
  await expect(page.getByRole('tab', { name })).toHaveCount(1);
  await expect(page.getByRole('tab', { name })).toHaveAccessibleDescription('Modified');
});


async function editHistoryMenu(page: Page, item: 'Undo' | 'Redo'): Promise<void> {
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('undoes and redoes typing and formatting through the keyboard and Edit menu, including after save', async ({ appPage: page }) => {
  const name = 'history.md';
  const group = await openMarkdown(page, name, 'Hello');
  const editor = richEditor(group);
  await expect(editor.getByText('Hello')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await page.keyboard.press('Shift+Home');
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<p>Hello <strong>world</strong></p>');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true, bubbles: true }));
  });
  await expect(editor.locator('strong')).toHaveText('world');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('Hello **world**');

  await editHistoryMenu(page, 'Undo');
  await expect(editor.locator('strong')).toHaveCount(0);
  await expect(editor).toHaveText('Hello world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Modified');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Hello');

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveText('Hello world');
  await editHistoryMenu(page, 'Redo');
  await expect(editor.locator('strong')).toHaveText('world');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
});

test('starts a new history at the current text when switching between modes', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'boundary.md', 'Start');
  const editor = richEditor(group);
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' rich');
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });

  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toContainText('Start rich');
  await page.keyboard.type(' source');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(group.locator('.view-lines')).toHaveText('Start rich source');

  await group.getByRole('button', { name: 'Switch to WYSIWYG' }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Start rich source');
  await page.keyboard.type(' later');
  await expect(editor).toHaveText('Start rich source later');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Start rich source');
});

test('offers keyboard access to rich-text history and hides the toolbar in source mode', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'toolbar.md', 'Start');
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const undo = toolbar.getByRole('button', { name: 'Undo' });
  const redo = toolbar.getByRole('button', { name: 'Redo' });
  await expect(toolbar).toBeVisible({ timeout: 20_000 });
  await expect(undo).toBeDisabled();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' text');
  await expect(undo).toBeEnabled();
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText('Start');
  await expect(redo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText('Start text');
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(toolbar).toBeHidden();
});

test('applies block styles from the toolbar, shortcut and command palette', async ({ appPage: page }) => {
  const name = 'block-styles.md';
  const group = await openMarkdown(page, name, 'First\n\nSecond');
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  await editor.getByText('First').click({ timeout: 20_000 });
  const style = toolbar.getByRole('button', { name: 'Style', exact: true });
  await expect(style).toHaveText('Body');
  await expect(style).toHaveAccessibleDescription('Body');
  await expect(style).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await style.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Style' });
  await expect(menu.getByRole('menuitemradio', { name: 'Body' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(style).toBeFocused();
  await expect(editor.getByRole('heading', { name: 'First', level: 2 })).toBeVisible();
  await expect(style).toHaveText('Heading 2');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('## First\n\nSecond');

  await editor.getByText('Second').click();
  await page.keyboard.press('ControlOrMeta+Alt+3');
  await expect(editor.getByRole('heading', { name: 'Second', level: 3 })).toBeVisible();
  await runCommand(page, 'Set Block Style', /^Markdown: Set Block Style$/);
  await page.getByRole('option', { name: 'Subtitle' }).click();
  await expect(editor.locator('p.subtitle')).toHaveText('Second');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('## First\n\nSecond {.subtitle}');
  await page.reload();
  await expect(editor.locator('p.subtitle')).toHaveText('Second', { timeout: 20_000 });
  await expect(editor.getByRole('heading')).toHaveCount(1);
});

test('checks concrete body defaults and updates an open pane when typography settings are saved', async ({ appPage: page }) => {
  const name = 'font-defaults.md';
  const headings = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Heading ${index + 1}`);
  const source = ['Body text', ...headings, 'Subtitle {.subtitle}', '- List item', '> Quote'].join('\n\n');
  const group = await openMarkdown(page, name, source);
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const size = toolbar.getByRole('button', { name: 'Size', exact: true });
  const font = toolbar.getByRole('button', { name: 'Font', exact: true });
  const sizeMenu = page.getByRole('menu', { name: 'Size' });
  const fontMenu = page.getByRole('menu', { name: 'Font' });
  const body = editor.getByText('Body text', { exact: true });

  for (const text of ['Body text', 'List item', 'Quote']) {
    const block = editor.getByText(text, { exact: true });
    await block.click();
    await expect(block).toHaveCSS('font-size', '16px');
    await expect(size).toHaveText('12 pt');
    await expect(font).toHaveText('Noto Sans KR');
  }

  const titleSizes = [24, 18, 14, 12, 10, 9, 16];
  for (const [index, points] of titleSizes.entries()) {
    const title = index < 6 ? editor.getByRole('heading', { level: index + 1 }) : editor.locator('p.subtitle');
    await title.click();
    expect(await title.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(points * 4 / 3);
    await expect(size).toHaveText(`${points} pt`);
    await size.click();
    await expect(sizeMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName(`${points} pt`);
    await page.keyboard.press('Escape');
  }

  const smallHeading = editor.getByRole('heading', { level: 3 });
  await smallHeading.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await size.click();
  await sizeMenu.getByRole('menuitemradio', { name: '18 pt', exact: true }).click();
  await expect(smallHeading).toHaveClass('size-18pt');
  await size.click();
  await sizeMenu.getByRole('menuitemradio', { name: '14 pt', exact: true }).click();
  await expect(smallHeading).not.toHaveClass('size-18pt');

  await body.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await font.click();
  await expect(fontMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName('Noto Sans KR');
  await page.keyboard.press('Escape');
  await size.click();
  await expect(sizeMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName('12 pt');
  await sizeMenu.getByRole('menuitemradio', { name: '14 pt', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('Body text {.size-14pt}');
  await size.click();
  await sizeMenu.getByRole('menuitemradio', { name: '12 pt', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe(source);

  await group.getByRole('button', { name: 'Split Editor Right' }).click();
  await openSettings(page);
  await replaceText(page, '{"markdownEditor.fontSize": 11, "markdownEditor.fontFamily": "noto-serif-kr"}');
  await saveSettings(page);

  await expect(size).toHaveText('11 pt');
  await expect(font).toHaveText('Noto Serif KR');
  expect(await body.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(44 / 3);
  await expect(body).toHaveCSS('font-family', /^"Noto Serif KR",/);
  await smallHeading.click();
  await expect(smallHeading).toHaveCSS('font-size', '16px');
  await expect(size).toHaveText('12 pt');
  await size.click();
  await expect(sizeMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName('12 pt');
  await page.keyboard.press('Escape');
  await body.click();
  await size.click();
  await expect(sizeMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName('11 pt');
  await page.keyboard.press('Escape');
  await font.click();
  await expect(fontMenu.getByRole('menuitemradio', { checked: true })).toHaveAccessibleName('Noto Serif KR');
  expect(await readWorkspaceText(page, name)).toBe(source);
});

test('uses monospace for inline code and regular weight for subtitles', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'code-and-subtitle-fonts.md', [
    'Body `plain`',
    'Styled `block` {.font-noto-serif-kr}',
    '[`span`]{.font-nanum-gothic}',
    'Subtitle {.subtitle}',
    '```\nfenced\n```\n\n{.font-noto-serif-kr}',
  ].join('\n\n'));
  const editor = richEditor(group);
  for (const sample of ['plain', 'block', 'span']) {
    await expect(editor.locator('p code').getByText(sample, { exact: true })).toHaveCSS('font-family', 'monospace');
  }
  await expect(editor.locator('p.subtitle')).toHaveCSS('font-weight', '400');
  await expect(editor.locator('pre > code')).toHaveCSS('font-family', /^"Noto Serif KR",/);
});

test('loads the four bundled Korean fonts at both weights with external requests blocked', async ({ page, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  const fontStyleRequests: string[] = [];
  let releaseFontStyles!: () => void;
  const allowFontStyles = new Promise<void>(resolve => { releaseFontStyles = resolve; });
  await page.route(/^https?:/, async route => {
    const url = route.request().url();
    const { origin: requestOrigin, pathname } = new URL(url);
    if (requestOrigin !== origin) {
      external.push(url);
      await route.abort('internetdisconnected');
      return;
    }
    // Production loads one CSS chunk. Vite's dev server loads the module that injects the CSS.
    if (markdownFontEntry.test(pathname)) {
      fontStyleRequests.push(pathname);
      await allowFontStyles;
    }
    await route.continue();
  });
  // The dev server serves each module separately and fills the default 250-entry resource timing buffer,
  // after which the font requests would not be recorded at all.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100_000));
  const familyAssets = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    .filter(entry => /(?:noto-(?:sans|serif)-kr|nanum-(?:gothic|myeongjo))-.*\.woff2$/.test(entry.name))
    .map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.encodedBodySize })));
  const families = [
    ['Noto Sans KR', 'Noto Sans KR'],
    ['Noto Serif KR', 'Noto Serif KR'],
    ['나눔고딕', 'Nanum Gothic'],
    ['나눔명조', 'Nanum Myeongjo'],
  ];
  let group: Locator;
  try {
    await page.goto('/');
    expect(fontStyleRequests).toEqual([]);
    expect(await familyAssets()).toEqual([]);
    expect(await page.evaluate(names => [...document.fonts]
      .filter(face => names.includes(face.family.replace(/["']/g, ''))).length, families.map(([, name]) => name))).toBe(0);

    group = await openMarkdown(page, 'webfonts.md', '한글 가나다 **굵은 한글**');
    await expect(richEditor(group).locator('p')).toHaveText('한글 가나다 굵은 한글');
    await expect.poll(() => fontStyleRequests.length).toBe(1);
    expect(await familyAssets()).toEqual([]);
  } finally {
    releaseFontStyles();
  }
  const paragraph = richEditor(group).locator('p');
  const font = group.getByRole('button', { name: 'Font', exact: true });
  const choose = (name: string) => page.getByRole('menuitemradio', { name, exact: true }).click();
  for (const [label, family] of families) {
    if (label !== 'Noto Sans KR') {
      await paragraph.click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await font.click();
      await choose(label);
    }
    expect(await paragraph.evaluate(node => getComputedStyle(node).fontFamily.split(',')[0].replace(/["']/g, ''))).toBe(family);
    await expect.poll(() => page.evaluate(name => [...document.fonts]
      .filter(face => face.family.replace(/["']/g, '') === name && face.status === 'loaded' && face.display === 'swap')
      .map(face => face.weight), family)).toEqual(expect.arrayContaining(['400', '700']));

    if (label === 'Noto Sans KR') {
      const initial = await familyAssets();
      expect(initial.length).toBeGreaterThan(0);
      expect(initial.every(entry => entry.path.includes('noto-sans-kr') && entry.bytes > 0)).toBe(true);
      await testInfo.attach('first-markdown-font-requests', {
        body: JSON.stringify({ requests: initial, totalBytes: initial.reduce((total, entry) => total + entry.bytes, 0) }),
        contentType: 'application/json',
      });
    }
  }
  await group.getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown editor' })).toHaveCount(2);
  expect(fontStyleRequests).toHaveLength(1);
  expect(external).toEqual([]);
});

test('loads bundled webfonts when the workbench restores a Markdown editor', async ({ appPage: page }) => {
  // Routing disables the HTTP cache so the restored document must load the font entry again.
  await page.route(markdownFontEntry, route => route.continue());
  const name = 'restore-webfonts.md';
  const text = '복원할 문서';
  const firstFontEntry = page.waitForResponse(markdownFontEntry);
  const group = await openMarkdown(page, name, text);
  const paragraph = richEditor(group).getByText(text, { exact: true });
  await expect(paragraph).toBeVisible();
  await expect(selectedTab(group)).toHaveText(name);
  expect((await firstFontEntry).ok()).toBe(true);

  const [fontEntry] = await Promise.all([page.waitForResponse(markdownFontEntry), page.reload()]);
  expect(fontEntry.ok()).toBe(true);
  await expect(selectedTab(group)).toHaveText(name);
  await expect(paragraph).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...document.fonts].some(face =>
    face.family.replace(/["']/g, '') === 'Noto Sans KR' && face.weight === '400' && face.status === 'loaded',
  ))).toBe(true);
});

test('saves paragraph alignment and inline size and font presets and restores their appearance', async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem('writing-room:storage:version', '2');
      localStorage.setItem(key, JSON.stringify({
        'markdownEditor.fontFamily': { serif: 'Cambria, serif', sans: '16px' },
        'workbench.colorTheme': 'Writing Room Light',
      }));
    }
  }, settingsKey);
  await page.goto('/');
  const name = 'presets.md';
  const legacy = 'Subheading {.subtitle .font-sans}\n\nLegacy serif {.font-serif}\n\nLegacy mono {.font-mono}';
  const group = await openMarkdown(page, name, `One word {.my-class}\n\n${legacy}`);
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const paragraph = editor.locator('p.my-class');
  await paragraph.click({ timeout: 20_000 });
  const alignCenter = toolbar.getByRole('button', { name: 'Align Center', exact: true });
  const alignRight = toolbar.getByRole('button', { name: 'Align Right', exact: true });
  await alignRight.click();
  await expect(paragraph).toHaveCSS('text-align', 'right');
  await expect(alignRight).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+l');
  await expect(paragraph).toHaveCSS('text-align', 'start');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(paragraph).toHaveCSS('text-align', 'center');
  await expect(alignCenter).toHaveAttribute('aria-pressed', 'true');
  await expect(editor).toBeFocused();

  await editor.focus();
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await toolbar.getByRole('button', { name: 'Size', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '18 pt', exact: true }).click();
  const font = toolbar.getByRole('button', { name: 'Font', exact: true });
  await font.click();
  const menu = page.getByRole('menu', { name: 'Font' });
  const families = [
    ['Noto Sans KR', 'Noto Sans KR'], ['Noto Serif KR', 'Noto Serif KR'],
    ['나눔명조', 'Nanum Myeongjo'], ['나눔고딕', 'Nanum Gothic'], ['monospace', 'monospace'],
  ];
  await expect(menu.getByRole('menuitemradio')).toHaveCount(families.length);
  const primaryFamily = (element: Locator) => element.evaluate(node =>
    getComputedStyle(node).fontFamily.split(',')[0].replace(/["']/g, ''));
  for (const [label, family] of families) {
    expect(await primaryFamily(menu.getByRole('menuitemradio', { name: label, exact: true }).getByText(label))).toBe(family);
  }
  await menu.getByRole('menuitemradio', { name: 'Noto Serif KR', exact: true }).click();
  await expect(font).toHaveText('Noto Serif KR');
  expect(await primaryFamily(font.getByText('Noto Serif KR'))).toBe('Noto Serif KR');
  const span = paragraph.locator('span.size-18pt.font-noto-serif-kr');
  await expect(span).toHaveText('word');
  await expect(span).toHaveCSS('font-size', '24px');
  expect(await primaryFamily(span)).toBe('Noto Serif KR');
  await expect(editor.locator('.subtitle')).toHaveCSS('color', 'rgb(90, 101, 119)');
  await expect(editor.locator('.subtitle')).toHaveCSS('font-family', 'system-ui, sans-serif');
  await expect(editor.locator('.font-serif')).toHaveCSS('font-family', 'Cambria, serif');
  await expect(editor.locator('.font-mono')).toHaveCSS('font-family', 'monospace');
  await editor.getByText('Legacy serif').click();
  await expect(font).toHaveText('Serif');
  await editor.getByText('Legacy mono').click();
  await expect(font).toHaveText('monospace');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe(
    `One [word]{.size-18pt .font-noto-serif-kr} {.my-class .center}\n\n${legacy}`,
  );
  await page.reload();
  await expect(paragraph).toHaveCSS('text-align', 'center', { timeout: 20_000 });
  await expect(span).toHaveText('word');
  expect(await primaryFamily(span)).toBe('Noto Serif KR');
  await chooseTheme(page, 'Writing Room Dark');
  await expect(editor.locator('.subtitle')).toHaveCSS('color', 'rgb(167, 182, 203)');
});

test('clears an alignment from the command palette and leaves existing justify readable', async ({ appPage: page }) => {
  const name = 'alignment.md';
  const justifiedSource = 'Justified {.center .justify}';
  const group = await openMarkdown(page, name, `Adjust me\n\n${justifiedSource}`);
  const editor = richEditor(group);
  const left = group.getByRole('button', { name: 'Align Left' });
  const center = group.getByRole('button', { name: 'Align Center' });
  const right = group.getByRole('button', { name: 'Align Right' });
  await editor.getByText('Adjust me').click({ timeout: 20_000 });
  await center.click();
  await expect(center).toHaveAttribute('aria-pressed', 'true');
  await right.click();
  await expect(right).toHaveAttribute('aria-pressed', 'true');
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe(`Adjust me {.right}\n\n${justifiedSource}`);
  await runCommand(page, 'Align Left', /^Markdown: Align Left$/);
  await expect(left).toHaveAttribute('aria-pressed', 'true');
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe(`Adjust me\n\n${justifiedSource}`);
  const justified = editor.getByText('Justified');
  await justified.click();
  await expect(justified).toHaveCSS('text-align', 'justify');
  for (const action of [left, center, right]) {
    await expect(action).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(group.getByRole('button', { name: /justify/i })).toHaveCount(0);
});

test('shows inherited alignment and saves left overrides inside a quote and nested list', async ({ appPage: page }) => {
  const name = 'inherited-alignment.md';
  const quote = '> Quoted paragraph\n>\n> Quoted sibling\n\n{.center}';
  const list = '- Parent {.right}\n    - Nested {.center}\n        - Deep paragraph\n        - Deep sibling';
  const source = `${quote}\n\n${list}`;
  const group = await openMarkdown(page, name, source);
  const editor = richEditor(group);
  const left = group.getByRole('button', { name: 'Align Left', exact: true });
  const center = group.getByRole('button', { name: 'Align Center', exact: true });
  const right = group.getByRole('button', { name: 'Align Right', exact: true });
  const quoted = editor.getByText('Quoted paragraph', { exact: true });
  const deep = editor.getByText('Deep paragraph', { exact: true });
  const siblings = [editor.getByText('Quoted sibling'), editor.getByText('Deep sibling')];
  const parent = editor.getByText('Parent', { exact: true });
  await expect(quoted).toHaveCSS('text-align', 'center', { timeout: 20_000 });
  await editor.press('ControlOrMeta+s');
  expect(await readWorkspaceText(page, name)).toBe(source);

  await parent.click();
  await expect(parent).toHaveCSS('text-align', 'right');
  await expect(right).toHaveAttribute('aria-pressed', 'true');
  await editor.press('ControlOrMeta+a');
  for (const button of [left, center, right]) {
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }

  for (const paragraph of [quoted, deep]) {
    await paragraph.click();
    await expect(paragraph).toHaveCSS('text-align', 'center');
    await expect(center).toHaveAttribute('aria-pressed', 'true');
    await left.click();
    await expect(paragraph).toHaveCSS('text-align', 'left');
    await expect(left).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(editor.locator('blockquote.center')).toHaveCount(1);
  await expect(editor.locator('li.center')).toHaveCount(1);
  for (const sibling of siblings) await expect(sibling).toHaveCSS('text-align', 'center');
  await editor.press('ControlOrMeta+s');
  const saved = source.replace('> Quoted paragraph', '> Quoted paragraph\n> {.left}')
    .replace('- Deep paragraph', '- Deep paragraph\n          {.left}');
  await expect.poll(() => readWorkspaceText(page, name)).toBe(saved);

  await page.reload();
  for (const paragraph of [quoted, deep]) {
    await expect(paragraph).toHaveCSS('text-align', 'left', { timeout: 20_000 });
    await paragraph.click();
    await expect(left).toHaveAttribute('aria-pressed', 'true');
  }
  for (const sibling of siblings) await expect(sibling).toHaveCSS('text-align', 'center');
});

test('applies bold without toggling the sidebar and keeps the workbench shortcut outside Markdown', async ({ appPage: page }) => {
  const name = 'inline.md';
  const group = await openMarkdown(page, name, 'Some text');
  const editor = richEditor(group);
  const paragraph = editor.locator('p');
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const bold = toolbar.getByRole('button', { name: 'Bold' });
  const sidebar = page.locator('[id="workbench.parts.sidebar"]');
  await paragraph.click({ timeout: 20_000 });
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await page.keyboard.press('ControlOrMeta+b');
  await expect(paragraph.locator('strong')).toHaveText('text');
  await expect(sidebar).toBeVisible();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('Some **text**');

  await paragraph.locator('strong').click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await bold.focus();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Italic' })).toBeFocused();
  await treeItem(page, name).focus();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toBeHidden();
});

test('opens the Markdown selection toolbox at the selection and shares the toolbar commands and state', async ({ appPage: page }) => {
  await page.setViewportSize({ width: 750, height: 465 });
  const name = 'selection-toolbox.md';
  const group = await openMarkdown(page, name, 'Alpha **beta** {.right}');
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const toolbox = page.getByRole('menu', { name: 'Markdown editor' });
  const beta = editor.locator('strong', { hasText: 'beta' });
  await beta.click({ timeout: 20_000 });
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft');
  await editor.evaluate(element => {
    element.addEventListener('contextmenu', event => queueMicrotask(() => {
      element.setAttribute('data-context-prevented', String(event.defaultPrevented));
    }), { once: true });
  });
  await beta.click({ button: 'right', modifiers: ['Shift'] });
  await expect(toolbox).toHaveCount(0);
  await expect(editor).toHaveAttribute('data-context-prevented', 'false');
  // Shift+right-click is native and may move the caret, so select the word again.
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft');
  const word = await box(beta);
  await beta.click({ button: 'right' });
  const popup = await box(toolbox);
  expect(word.x + popup.width).toBeGreaterThan(750);
  expect(Math.abs(popup.x - word.x)).toBeLessThan(popup.width);
  expect(Math.abs(popup.y - word.y)).toBeLessThan(popup.height);
  expect(popup.x).toBeGreaterThanOrEqual(0);
  expect(popup.y).toBeGreaterThanOrEqual(0);
  expect(popup.x + popup.width).toBeLessThanOrEqual(750);
  expect(popup.y + popup.height).toBeLessThanOrEqual(465);
  const row = toolbox.getByRole('group');
  expect(await row.getByRole('menuitemcheckbox').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))))
    .toEqual(['Bold', 'Italic', 'Underline', 'Strikethrough']);
  await expect(row.getByRole('menuitem')).toHaveText(['Style⌄', 'Size⌄', 'Font⌄']);
  await expect(toolbox.getByRole('menuitem', { name: 'Cut' })).toBeEnabled();
  await expect(toolbox.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
  const bold = row.getByRole('menuitemcheckbox', { name: 'Bold' });
  await expect(bold).toHaveAttribute('aria-checked', 'true');
  await expect(bold).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(row.getByRole('menuitemcheckbox', { name: 'Underline' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toolbox).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor.locator('u.underline')).toHaveText('beta');
  await expect(toolbar.getByRole('button', { name: 'Underline' })).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Shift+F10');
  await expect(row.getByRole('menuitemcheckbox', { name: 'Underline' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(row.getByRole('menuitem', { name: 'Font' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(toolbox.getByRole('menuitem', { name: 'Undo' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(row.getByRole('menuitem', { name: 'Font' })).toBeFocused();
  await page.keyboard.press('Enter');
  const fonts = page.getByRole('menu', { name: 'Font' });
  await expect(fonts.getByRole('menuitemradio', { checked: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fonts).toHaveCount(0);
  await expect(toolbox).toHaveCount(0);
  await expect(editor).toBeFocused();

  await beta.click({ button: 'right' });
  await row.getByRole('menuitem', { name: 'Size' }).click();
  await page.getByRole('menuitemradio', { name: '24 pt' }).click();
  await expect(editor.locator('u.underline.size-24pt')).toHaveText('beta');
  await beta.click({ button: 'right' });
  await row.getByRole('menuitem', { name: 'Style' }).click();
  await page.getByRole('menuitemradio', { name: 'Heading 2' }).click();
  await expect(editor.getByRole('heading', { level: 2 }).locator('u')).toHaveText('beta');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe('## Alpha [**beta**]{.underline .size-24pt} {.right}');

  await beta.click();
  await beta.click({ button: 'right' });
  await expect(toolbox).toBeVisible();
  await expect(toolbox.getByRole('group')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  const source = group.getByRole('textbox', { name: 'Editor content' });
  await expect(source).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await group.locator('.view-lines').click({ button: 'right' });
  await expect(toolbox).toHaveCount(0);
});

test('shows basic editing commands at the Markdown caret and shares editor history', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'edit-menu.md', 'First paragraph\n\nSecond paragraph');
  const editor = richEditor(group);
  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true });
  const first = editor.getByText('First paragraph', { exact: true });
  await first.click({ button: 'right', timeout: 20_000 });
  await expect(menu.getByRole('group')).toHaveCount(0);
  expect(await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))))
    .toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Paste as Plain Text', 'Select All']);
  await expect(menu.locator('.wr-menu-shortcut')).toHaveText([
    /^(Ctrl\+|⌘)Z$/, /^(Ctrl\+Y|⇧⌘Z)$/, /^(Ctrl\+|⌘)X$/, /^(Ctrl\+|⌘)C$/,
    /^(Ctrl\+|⌘)V$/, /^(Ctrl\+Shift\+|⇧⌘)V$/, /^(Ctrl\+|⌘)A$/,
  ]);
  for (const name of ['Undo', 'Redo', 'Cut', 'Copy']) await expect(item(name)).toBeDisabled();
  await expect(item('Paste')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('Paste as Plain Text')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item('Select All')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toMatch(/First paragraph\s+Second paragraph/);

  await first.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('ContextMenu');
  await expect(item('Undo')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first).toBeVisible();
  await page.keyboard.press('Shift+F10');
  await expect(item('Undo')).toBeDisabled();
  await expect(item('Redo')).toBeEnabled();
  await item('Redo').click();
  await expect(editor.getByText('First paragraph!', { exact: true })).toBeVisible();
  await expect(editor).toBeFocused();
});

test('moves the Markdown caret and opens basic editing commands outside a selection', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'outside-selection.md', 'Select me\n\nOutside text');
  const editor = richEditor(group);
  await editor.getByText('Select me').click({ timeout: 20_000 });
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Select me');
  await editor.evaluate(element => {
    element.addEventListener('contextmenu', event => queueMicrotask(() => {
      element.setAttribute('data-context-prevented', String(event.defaultPrevented));
    }), { once: true });
  });
  const outside = editor.getByText('Outside text');
  const point = await outside.evaluate(element => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 3);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    const paragraph = element.getBoundingClientRect();
    return { x: rect.left - paragraph.left, y: rect.top - paragraph.top + rect.height / 2 };
  });
  await outside.click({ position: point, button: 'right' });
  await expect(editor).toHaveAttribute('data-context-prevented', 'true');
  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeDisabled();
  await expect(menu.getByRole('group')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect.poll(() => outside.evaluate(element => {
    const selection = document.getSelection()!;
    return { collapsed: selection.isCollapsed, onClickedText: element.contains(selection.anchorNode), offset: selection.anchorOffset };
  })).toEqual({ collapsed: true, onClickedText: true, offset: 3 });
  await page.keyboard.type('X');
  await expect(editor.locator('p')).toHaveText(['Select me', 'OutXside text']);

  await editor.getByText('Select me').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Select me');
  const body = await box(editor);
  const second = await box(editor.getByText('OutXside text'));
  await page.mouse.click(body.x - 8, second.y + second.height / 2, { button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeDisabled();
  await expect(menu.getByRole('group')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.type('Y');
  await expect(editor.locator('p')).toHaveText(['Select me', 'YOutXside text']);
});

test('allows Copy and Select All in the read-only Markdown context menu', async ({ appPage: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedInstalledExtensions(page, [{
    manifest: JSON.parse(readFileSync(new URL('../fixtures/extensions/memfs/package.json', import.meta.url), 'utf8')),
    location: extensionFixtureLocation('memfs'),
  }]);
  await page.reload();
  await runCommand(page, 'Open Read-only Markdown Fixture', /^Open Read-only Markdown Fixture$/);
  const group = groups(page).first();
  const editor = richEditor(group);
  const text = editor.getByText('Read-only Markdown');
  await expect(text).toBeVisible({ timeout: 20_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(editor).toHaveAttribute('aria-readonly', 'true');
  const point = await text.evaluate(element => {
    const selection = document.getSelection()!;
    selection.selectAllChildren(element);
    element.addEventListener('contextmenu', event => queueMicrotask(() => {
      element.setAttribute('data-context-prevented', String(event.defaultPrevented));
    }), { once: true });
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(text).toHaveAttribute('data-context-prevented', 'true');
  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  for (const name of ['Undo', 'Redo', 'Cut', 'Paste', 'Paste as Plain Text']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeDisabled();
  }
  const formatting = menu.getByRole('group');
  await expect(formatting.getByRole('menuitemcheckbox', { name: 'Bold' })).toBeDisabled();
  await expect(formatting.getByRole('menuitem', { name: 'Style' })).toBeDisabled();
  const copy = menu.getByRole('menuitem', { name: 'Copy' });
  await expect(copy).toBeFocused();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Read-only Markdown');
  await expect(editor).toBeFocused();
  await text.evaluate(() => document.getSelection()!.removeAllRanges());
  await page.keyboard.press('Shift+F10');
  await expect(copy).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Select All' }).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Read-only Markdown');
});

test('cuts, copies and pastes through the Markdown selection toolbox and sanitizes rich paste', async ({ appPage: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const group = await openMarkdown(page, 'toolbox-clipboard.md', 'First [**word**]{.underline}\n\nReplace this');
  const editor = richEditor(group);
  const toolbox = page.getByRole('menu', { name: 'Markdown editor' });
  const word = editor.locator('u strong');
  const selectWord = async () => {
    await word.click({ timeout: 20_000 });
    await page.keyboard.press('End');
    for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowLeft');
    await word.click({ button: 'right' });
  };
  await selectWord();
  await toolbox.getByRole('menuitem', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('[**word**]{.underline}');
  await expect(word).toHaveText('word');
  const copiedHTML = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item.getType('text/html')).text();
  });
  expect(copiedHTML).toContain('<u class="underline"><strong>word</strong></u>');
  await selectWord();
  await toolbox.getByRole('menuitem', { name: 'Cut' }).click();
  await expect(editor.locator('p').first()).toHaveText('First ');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('[**word**]{.underline}');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(word).toHaveText('word');

  const replacement = editor.getByText('Replace this');
  await replacement.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.evaluate(async () => {
    const html = '<p><a href="javascript:void(0)" id="foreign">Unsafe URL</a> <u class="keep" title="valid">safe</u> ' +
      '<span style="text-decoration: underline">Docs underline</span> ' +
      '<a href="/linked" style="text-decoration: underline"><span style="text-decoration-line: underline">Docs link</span></a></p>';
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob(['plain fallback'], { type: 'text/plain' }),
    })]);
  });
  expect(await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item.getType('text/html')).text();
  })).toContain('id="foreign"');
  await page.keyboard.press('Shift+F10');
  await toolbox.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect(editor.locator('p').last()).toHaveText('Unsafe URL safe Docs underline Docs link');
  await expect(editor.getByRole('link', { name: 'Unsafe URL' })).toHaveCount(0);
  await expect(editor.locator('u.keep.underline')).toHaveText('safe');
  await expect(editor.locator('u.underline', { hasText: 'Docs underline' })).toBeVisible();
  const docsLink = editor.getByRole('link', { name: 'Docs link' });
  await expect(docsLink).toHaveAttribute('href', new URL('/linked', page.url()).href);
  await expect(docsLink).not.toHaveAttribute('style');
  await expect(docsLink.locator('u, .underline, [style]')).toHaveCount(0);
  await expect(editor.locator('#foreign')).toHaveCount(0);

  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.evaluate(() => navigator.clipboard.writeText('**Markdown**'));
  await page.keyboard.press('Shift+F10');
  await toolbox.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect(editor.locator('p').last().locator('strong')).toHaveText('Markdown');
});

for (const item of ['Paste', 'Paste as Plain Text']) {
  test(`warns and retains the selection when the browser denies ${item} clipboard permission`, async ({ appPage: page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Browser.setPermission', {
      permission: { name: 'clipboard-read' }, setting: 'denied', origin: new URL(page.url()).origin,
    });
    const group = await openMarkdown(page, 'cannot-paste.md', 'Keep this selection');
    const editor = richEditor(group);
    await editor.getByText('Keep this selection').click({ timeout: 20_000 });
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menu', { name: 'Markdown editor' }).getByRole('menuitem', { name: item, exact: true }).click();
    await expect(page.getByText('Could not paste using the clipboard. Try the keyboard shortcut.', { exact: true })).toBeVisible();
    await expect(editor).toHaveText('Keep this selection');
    await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Keep this selection');
  });
}

test('pastes only literal unformatted clipboard text from the Markdown context menu and shortcut', async ({ appPage: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const name = 'plain-text-paste.md';
  const group = await openMarkdown(page, name, '**Before Replace After**\n\nSecond');
  const editor = richEditor(group);
  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  const plain = menu.getByRole('menuitem', { name: 'Paste as Plain Text' });
  const writeClipboard = (text: string, includePlain = true) => page.evaluate(async ({ text, includePlain }) => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob(['<h1>HTML-only title</h1>'], { type: 'text/html' }),
      ...(includePlain ? { 'text/plain': new Blob([text], { type: 'text/plain' }) } : {}),
    })]);
  }, { text, includePlain });
  await editor.locator('strong').click({ timeout: 20_000 });
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Before '.length; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'Replace'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Replace');

  await writeClipboard('', false);
  await page.keyboard.press('Shift+F10');
  await plain.click();
  await expect(editor.locator('strong').first()).toHaveText('Before Replace After');
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Replace');
  await page.keyboard.press('ControlOrMeta+Shift+v');
  await expect(editor.locator('strong').first()).toHaveText('Before Replace After');
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('Replace');

  await writeClipboard('**Literal**');
  await page.keyboard.press('Shift+F10');
  await plain.click();
  await expect(editor.locator('p').first()).toHaveText('Before **Literal** After');
  await expect(editor.locator('p').first().locator('strong')).toHaveText(['Before ', ' After']);
  await expect(editor.getByRole('heading')).toHaveCount(0);

  await editor.getByText('Second').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await writeClipboard('# Literal title\n- Literal list');
  await page.keyboard.press('ControlOrMeta+Shift+v');
  await expect(editor.locator('p').nth(1)).toHaveText('# Literal title');
  await expect(editor.locator('p').nth(2)).toHaveText('- Literal list');
  await expect(editor.getByRole('heading')).toHaveCount(0);
  await expect(editor.locator('ul')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('\\# Literal title\n\n\\- Literal list');
});

test('discards a clipboard read if the original Markdown caret moves while it is pending', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'pending-context-paste.md', 'Keep this text');
  const editor = richEditor(group);
  const paragraph = editor.locator('p');
  await paragraph.click({ timeout: 20_000 });
  await page.keyboard.press('End');
  await page.evaluate(() => {
    navigator.clipboard.readText = () => new Promise(resolve => {
      document.documentElement.dataset.testClipboardPending = 'true';
      window.addEventListener('test-complete-clipboard-read', () => resolve('Late text'), { once: true });
    });
  });
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Markdown editor' }).getByRole('menuitem', { name: 'Paste as Plain Text' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-test-clipboard-pending', 'true');
  await expect(editor).toBeFocused();
  await paragraph.click({ position: { x: 1, y: 5 } });
  await expect.poll(() => editor.evaluate(() => document.getSelection()?.anchorOffset)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('test-complete-clipboard-read')));
  await expect(editor).toHaveText('Keep this text');
  await page.keyboard.type('!');
  await expect(editor).toHaveText('!Keep this text');
});

test('prefills, validates, edits and removes a link through the shortcut, toolbar and palette', async ({ appPage: page }) => {
  const name = 'link.md';
  const group = await openMarkdown(page, name, 'An [example](https://example.com/) link');
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const url = page.getByRole('textbox', { name: 'Edit Link' });
  const example = editor.getByRole('link', { name: 'example' });
  await example.click({ timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+k');
  await expect(url).toBeFocused();
  await expect(url).toHaveValue('https://example.com/');
  await url.fill('javascript:');
  await expect(page.getByText('Enter a valid link destination.')).toBeVisible();
  await url.press('Enter');
  await expect(url).toBeVisible();
  await url.fill('/other.md');
  await url.press('Enter');
  await expect(example).toHaveAttribute('href', '/other.md');

  await toolbar.getByRole('button', { name: 'Edit Link' }).click();
  await expect(url).toHaveValue('/other.md');
  await url.fill('/discarded.md');
  await url.press('Escape');
  await expect(example).toHaveAttribute('href', '/other.md');

  await runCommand(page, 'Edit Link', /^Markdown: Edit Link$/);
  await expect(url).toHaveValue('/other.md');
  await url.fill('');
  await url.press('Enter');
  await expect(example).toHaveCount(0);
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe('An example link');
});

test('targets the toolbar’s editor group when another Markdown editor has focus', async ({ appPage: page }) => {
  const left = await openMarkdown(page, 'left-formatting.md', 'Left editor');
  const leftEditor = richEditor(left);
  await leftEditor.getByText('Left editor').click({ timeout: 20_000 });
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const right = groups(page).nth(1);
  await expect(richEditor(right)).toHaveText('Left editor');
  await writeWorkspaceFile(page, 'right-formatting.md', 'Right editor');
  await treeItem(page, 'right-formatting.md').dblclick();
  const rightEditor = richEditor(right);
  await rightEditor.getByText('Right editor').click();
  await expect(rightEditor).toBeFocused();

  await left.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Heading 2' }).click();
  await expect(leftEditor.getByRole('heading', { name: 'Left editor', level: 2 })).toBeVisible();
  await expect(rightEditor.locator('p')).toHaveText('Right editor');
  await expect(right.getByRole('button', { name: 'Style', exact: true })).toHaveText('Body');
});

test('creates, edits and saves a GFM table from the toolbar', async ({ appPage: page }) => {
  const name = 'blocks-table.md';
  const group = await openMarkdown(page, name, '');
  const editor = richEditor(group);
  await editor.click();
  await group.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert Table', exact: true }).click();
  await expect(editor.locator('th')).toHaveCount(2);
  await page.keyboard.type('First');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Second');
  await group.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add Column After', exact: true }).click();
  await expect(editor.locator('th')).toHaveCount(3);
  await page.keyboard.type('Third');
  await runCommand(page, 'Align Column Center', /^Markdown: Align Column Center$/);
  await expect(editor.locator('th').last()).toHaveCSS('text-align', 'center');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe('| First | Second | Third |\n| --- | --- | :---: |\n|  |  |  |');
  await page.reload();
  await expect(editor.locator('th')).toHaveText(['First', 'Second', 'Third'], { timeout: 20_000 });
  await expect(editor.locator('th').last()).toHaveCSS('text-align', 'center');
});

test('pastes HTML table spans as single cells and replaces a selected cell range', async ({ appPage: page }) => {
  const name = 'table-paste.md';
  const group = await openMarkdown(page, name, '');
  const editor = richEditor(group);
  const pasteTable = (html: string) => editor.evaluate((element, content) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', content);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true, bubbles: true }));
  }, html);

  await editor.focus();
  await pasteTable('<table><tr><td colspan="2" class="important" style="text-align:right">A</td><th>B</th></tr>'
    + '<tr><th rowspan="2">C</th><td>D</td></tr><tr><td>E</td><td>F</td></tr></table>');
  await expect(editor.locator('th')).toHaveText(['A', 'B']);
  await expect(editor.locator('td')).toHaveText(['C', 'D', 'E', 'F']);
  await expect(editor.locator('[colspan], [rowspan]')).toHaveCount(0);
  await expect(editor.locator('td').first()).toHaveCSS('text-align', 'right');

  await editor.getByText('C', { exact: true }).click();
  await editor.getByText('F', { exact: true }).click({ modifiers: ['Shift'] });
  await expect(editor.locator('td.selectedCell')).toHaveCount(4);
  await pasteTable('<table><tr><th colspan="2" style="text-align:center">X</th><td>Y</td></tr>'
    + '<tr><td>Z</td><td>W</td></tr></table>');
  await expect(editor.locator('th')).toHaveText(['A', 'B']);
  await expect(editor.locator('td')).toHaveText(['X', 'Y', 'Z', 'W']);
  await expect(editor.locator('td').first()).toHaveCSS('text-align', 'right');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe('| A {.important} | B |\n| ---: | --- |\n| X | Y |\n| Z | W |');
  await page.reload();
  await expect(editor.locator('th').first()).toHaveClass('important', { timeout: 20_000 });
  await expect(editor.locator('td')).toHaveText(['X', 'Y', 'Z', 'W']);
  await expect(editor.locator('[colspan], [rowspan]')).toHaveCount(0);
});

test('toggles a task, exits a list, and loads remote images only on request', async ({ appPage: page }) => {
  const name = 'blocks-list.md';
  const group = await openMarkdown(page, name, '- [ ] Check me\n\n![Remote](https://images.example.test/photo.png)\n\n![Blocked](http://images.example.test/photo.png)');
  const editor = richEditor(group);
  const requests: string[] = [];
  await page.route('**/photo.png', async route => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: 'image/png', body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XGl0AAAAASUVORK5CYII=', 'base64',
    ) });
  });
  const task = editor.getByRole('checkbox', { name: 'Task completed' });
  await expect(task).not.toBeChecked();
  await task.click();
  await expect(task).toBeChecked();
  await expect(editor.getByText('HTTP image blocked', { exact: false })).toBeVisible();
  expect(requests).toEqual([]);
  await editor.getByRole('button', { name: 'Load image' }).click();
  await expect.poll(() => requests).toEqual(['https://images.example.test/photo.png']);
  await expect(editor.locator('img[alt="Remote"]')).toBeVisible();
  await editor.getByText('Check me').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Outside');
  await expect(editor.locator(':scope > p').first()).toHaveText('Outside');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('- [x] Check me\n\nOutside');
  expect(await readWorkspaceText(page, name)).toContain('![Blocked](http://images.example.test/photo.png)');
});

test('pastes a web heading, list and link as Markdown and strips unrelated HTML', async ({ appPage: page }) => {
  const name = 'web-paste.md';
  const group = await openMarkdown(page, name, '');
  const editor = richEditor(group);
  await editor.focus();
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', [
      '<h2 style="text-align:center;color:red">Heading</h2>',
      '<ul><li>First</li><li>Second</li></ul>',
      '<p><a href="https://example.test/" onclick="fail()">Good link</a> ',
      '<a href="java&#10;script:fail()">Rejected link</a></p>',
      '<script>discardScript()</script><style>discardStyles</style>',
    ].join(''));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true, bubbles: true }));
  });
  const heading = editor.getByRole('heading', { name: 'Heading' });
  await expect(heading).toHaveCSS('text-align', 'center');
  await expect(heading).not.toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(editor.locator('li')).toHaveText(['First', 'Second']);
  await expect(editor.getByRole('link')).toHaveText('Good link');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe(
    '## Heading {.center}\n\n- First\n- Second\n\n[Good link](https://example.test/) Rejected link',
  );
});

test('pastes Markdown text and uses the Shift shortcut for literal text', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'text-paste.md', '');
  const editor = richEditor(group);
  await editor.focus();
  async function pasteText(text: string): Promise<void> {
    await editor.evaluate((element, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, cancelable: true, bubbles: true }));
    }, text);
  }
  await pasteText('# Parsed title\n\n**Bold**');
  await expect(editor.getByRole('heading')).toHaveText('Parsed title');
  await expect(editor.locator('strong')).toHaveText('Bold');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.down('Shift');
  await pasteText('**Literal**');
  await page.keyboard.up('Shift');
  await expect(editor.locator('p').last()).toHaveText('**Literal**');
  await expect(editor.locator('strong')).toHaveCount(1);
});

test('keeps list Tab in the editor and saves the nested task structure', async ({ appPage: page }) => {
  const name = 'nested-list.md';
  const group = await openMarkdown(page, name, '- Parent\n- [x] Child');
  const editor = richEditor(group);
  await editor.getByText('Child').click();
  await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  await expect(editor.locator('ul ul > li')).toHaveText('Child');
  await expect(editor.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Shift+Tab');
  await expect(editor.locator(':scope > ul > li')).toHaveCount(2);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe('- Parent\n    - [x] Child');
  await page.reload();
  await expect(editor.locator('ul ul > li')).toHaveText('Child', { timeout: 20_000 });
  await expect(editor.getByRole('checkbox')).toBeChecked();
});

test('renders and edits an image relative to the Markdown document folder', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'notes/assets/pixel.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    ['notes', 'notes/assets']);
  const name = 'notes/local-image.md';
  await writeWorkspaceFile(page, name, '![Pixel](assets/pixel.svg)\n\n![Missing](../../outside.svg)');
  await treeItem(page, 'notes').click();
  await treeItem(page, 'local-image.md').dblclick();
  const group = groups(page).first();
  const editor = richEditor(group);
  const image = editor.getByRole('img', { name: 'Pixel' });
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(10);
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect(editor.getByText('Image is outside the workspace folder', { exact: false })).toBeVisible();
  await image.click();
  await group.getByRole('button', { name: 'Image', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Image Address' });
  await expect(address).toHaveValue('assets/pixel.svg');
  await address.press('Enter');
  const description = page.getByRole('textbox', { name: 'Image Description' });
  await description.fill('Edited description');
  await description.press('Enter');
  await expect(editor.getByRole('img', { name: 'Edited description' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('![Edited description](assets/pixel.svg)');
});

test('copies rendered HTML and Markdown text to the clipboard', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'copy.md', '## Heading\n\nOne **bold** [link](https://example.test/)');
  const editor = richEditor(group);
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  const data = await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent('copy', { clipboardData, cancelable: true, bubbles: true }));
    return { markdown: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
  });
  expect(data.markdown).toBe('## Heading\n\nOne **bold** [link](https://example.test/)');
  expect(data.html).toContain('<strong>bold</strong>');
  expect(data.html).toContain('<a href="https://example.test/">link</a>');
});

test('updates word counts and navigates the outline in visual and source Markdown', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'outline.md', '# First\n\n한글 **문장**\n\n### Nested\n\nCaption {.subtitle}\n\n## Last');
  const editor = richEditor(group);
  const outline = page.getByRole('region', { name: 'Outline' });
  const count = page.getByText(/^6 words · /);
  await expect(count).toBeVisible();
  await expect(outline.getByRole('button')).toHaveText(['First', 'Nested', 'Last']);
  await outline.getByRole('button', { name: 'Nested' }).click();
  await expect(outline.getByRole('button', { name: 'Nested' })).toHaveAttribute('aria-current', 'location');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Shift+End');
  await expect(page.getByText('Selection · 1 word · 6 characters · 6 without spaces')).toBeVisible();
  await page.keyboard.type('Renamed');
  await expect(outline.getByRole('button', { name: 'Renamed' })).toHaveAttribute('aria-current', 'location');

  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  const source = group.getByRole('textbox', { name: 'Editor content' });
  await expect(source).toBeFocused();
  await expect(count).toBeVisible();
  await outline.getByRole('button', { name: 'Last' }).click();
  await expect(outline.getByRole('button', { name: 'Last' })).toHaveAttribute('aria-current', 'location');
  await expect(source).toBeFocused();
  await page.keyboard.press('Shift+End');
  await expect(page.getByText('Selection · 1 word · 4 characters · 4 without spaces')).toBeVisible();
  await page.keyboard.type('Final');
  await expect(outline.getByRole('button', { name: 'Final' })).toHaveAttribute('aria-current', 'location');
});

test('focus mode restores part sizes and keeps a previously hidden part hidden', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'focus.md', 'First paragraph\n\nSecond paragraph');
  const editor = richEditor(group);
  const part = (name: string) => page.locator(`[id="workbench.parts.${name}"]`);
  const sidebar = part('sidebar');
  const panel = part('panel');
  const statusbar = part('statusbar');
  const activitybar = part('activitybar');
  const bounds = await box(sidebar);
  await drag(page, bounds.x + bounds.width, 175, bounds.x + bounds.width + 55, 175);
  await runCommand(page, 'Toggle Panel Visibility', /^View: Toggle Panel Visibility$/);
  await expect(panel).toBeHidden();
  const resized = await box(sidebar);
  const writingWidth = (await box(editor)).width;
  await runCommand(page, 'Toggle Focus Mode', /^Markdown: Toggle Focus Mode$/);
  for (const element of [sidebar, panel, statusbar, activitybar]) await expect(element).toBeHidden();
  expect((await box(editor)).width).toBeLessThan(writingWidth);
  await expect(editor.getByText('First paragraph')).toHaveCSS('opacity', '1');
  await expect(editor.getByText('Second paragraph')).toHaveCSS('opacity', '0.45');
  await editor.getByText('Second paragraph').click();
  await expect(editor.getByText('Second paragraph')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Escape');
  for (const element of [sidebar, statusbar, activitybar]) await expect(element).toBeVisible();
  await expect(panel).toBeHidden();
  expect(await box(sidebar)).toEqual(resized);
  await expect(editor.getByText('First paragraph')).toHaveCSS('opacity', '1');
  await runCommand(page, 'Toggle Focus Mode', /^Markdown: Toggle Focus Mode$/);
  await runCommand(page, 'Toggle Focus Mode', /^Markdown: Toggle Focus Mode$/);
  await expect(sidebar).toBeVisible();
});

test('focus mode yields to layout commands and lets Escape close quick input first', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'focus-yield.md', 'Text');
  const editor = richEditor(group);
  const sidebar = page.locator('[id="workbench.parts.sidebar"]');
  const statusbar = page.locator('[id="workbench.parts.statusbar"]');
  await runCommand(page, 'Toggle Focus Mode', /^Markdown: Toggle Focus Mode$/);
  await expect(statusbar).toBeHidden();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Status Bar', exact: true }).click();
  await expect(statusbar).toBeVisible();
  await group.getByRole('button', { name: 'Image', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Image Address' });
  await expect(address).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(address).toBeHidden();
  await expect(sidebar).toBeHidden();
  await editor.click();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeVisible();
  await expect(statusbar).toBeVisible();
});

test('typewriter scrolling centers the first, middle and newly written last line', async ({ page }) => {
  const group = await openTypewriterMarkdown(page, 'typewriter.md',
    Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join('\n\n'));
  const editor = richEditor(group);
  await editor.focus();
  const caretDistance = () => editor.evaluate(element => {
    const selection = element.ownerDocument.getSelection()!;
    if (!selection.rangeCount) return Infinity;
    const range = selection.getRangeAt(0);
    const caret = range.getBoundingClientRect();
    const surface = element.parentElement!;
    return Math.abs((caret.top + caret.bottom) / 2 - (surface.getBoundingClientRect().top + surface.clientHeight / 2));
  });
  await expect.poll(caretDistance).toBeLessThan(3);
  await editor.getByText('Line 16', { exact: true }).click();
  await expect.poll(caretDistance).toBeLessThan(3);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('New last line');
  await expect.poll(caretDistance).toBeLessThan(3);
});

test('keeps the typewriter viewport in place when dragging across table cells', async ({ page }) => {
  const paragraphs = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n\n');
  const table = '| First | Last |\n| --- | --- |\n| A | B |\n| C | D |\n| E | F |';
  const group = await openTypewriterMarkdown(page, 'typewriter-table.md', [paragraphs, table, paragraphs].join('\n\n'));
  const editor = richEditor(group);
  const surface = group.locator('.markdown-typewriter');
  const header = editor.getByRole('columnheader', { name: 'First', exact: true });
  await expect(surface).toBeVisible();
  await expect(header).toBeVisible();

  const scrollTop = await surface.evaluate(async element => {
    // Let opening the editor finish any queued caret centering before setting the test viewport.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const table = element.querySelector('table')!.getBoundingClientRect();
    element.scrollTop += table.top - element.getBoundingClientRect().top - element.clientHeight / 8;
    return element.scrollTop;
  });
  const first = await box(header);
  const last = await box(editor.getByRole('cell', { name: 'F', exact: true }));
  await drag(page, first.x + first.width / 2, first.y + first.height / 2,
    last.x + last.width / 2, last.y + last.height / 2);

  const afterDrag = await surface.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return element.scrollTop;
  });
  expect(Math.abs(afterDrag - scrollTop)).toBeLessThan(2);
  await expect(editor.locator('.selectedCell')).toHaveCount(8);
});

test('renders absolute point sizes and still scales authored legacy sizes relative to each block', async ({ appPage: page }) => {
  const name = 'relative-size.md';
  const points = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
  const prefixes = [...Array.from({ length: 6 }, (_, index) => '#'.repeat(index + 1) + ' '), '', ''];
  const blocks = prefixes.flatMap((prefix, index) => ['size-sm', '', 'size-lg', 'size-xl'].map((preset, variant) => {
    const classes = [index === 6 ? 'subtitle' : '', preset].filter(Boolean).map(name => '.' + name).join(' ');
    return `${prefix}Example ${index} ${variant}${classes ? ' {' + classes + '}' : ''}`;
  }));
  const group = await openMarkdown(page, name, [
    ...blocks, ...points.map(point => `# Point size {.size-${point}pt}`),
  ].join('\n\n'));
  const editor = richEditor(group);
  await expect(editor.getByText('Example 0 1', { exact: true })).toBeVisible({ timeout: 20_000 });
  const sizes = await editor.locator(':scope > :is(h1,h2,h3,h4,h5,h6,p)').evaluateAll(elements =>
    elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)));
  for (let index = 0; index < prefixes.length; index++) {
    const row = sizes.slice(index * 4, index * 4 + 4);
    expect(row).toHaveLength(4);
    expect(row[0]).toBeLessThan(row[1]);
    expect(row[1]).toBeLessThan(row[2]);
    expect(row[2]).toBeLessThan(row[3]);
  }
  const pointPixels = await editor.getByRole('heading', { name: 'Point size' }).evaluateAll(elements =>
    elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(pointPixels).toHaveLength(points.length);
  points.forEach((point, index) => expect(pointPixels[index]).toBeCloseTo(point * 4 / 3, 3));

  const title = editor.getByRole('heading', { name: 'Example 0 1' });
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const size = toolbar.getByRole('button', { name: 'Size', exact: true });
  await editor.getByRole('heading', { name: 'Example 0 0' }).click();
  await expect(size).toHaveText('Custom');
  // A selection across differently sized blocks has no single size, so it shows the dash rather than Custom.
  await page.keyboard.press('Home');
  await title.click({ modifiers: ['Shift'] });
  await expect(size).toHaveText('—');
  await editor.getByRole('heading', { name: 'Example 0 0' }).click();
  await expect(size).toHaveText('Custom');
  await size.click();
  const menu = page.getByRole('menu', { name: 'Size' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(points.map(point => `${point} pt`));
  await page.keyboard.press('Escape');
  await title.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await size.click();
  await menu.getByRole('menuitemradio', { name: '18 pt', exact: true }).click();
  await expect(title).toHaveCSS('font-size', '24px');
  await expect(size).toHaveText('18 pt');
  await size.click();
  await menu.getByRole('menuitemradio', { name: '24 pt', exact: true }).click();
  await expect(title).toHaveCSS('font-size', '32px');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  await size.click();
  await menu.getByRole('menuitemradio', { name: '36 pt', exact: true }).click();
  await expect(title.locator('.size-36pt')).toHaveCSS('font-size', '48px');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('# Example 0 [1]{.size-36pt}');
  expect(await readWorkspaceText(page, name)).toContain('# Example 0 0 {.size-sm}');
  await page.reload();
  await expect(title.locator('.size-36pt')).toHaveCSS('font-size', '48px', { timeout: 20_000 });
});

test('uses Tab to indent code and lets Tab leave ordinary Markdown text', async ({ appPage: page }) => {
  const group = await openMarkdown(page, 'code-tab.md', 'Ordinary paragraph\n\n```\nfirst\nsecond\n```');
  const editor = richEditor(group);
  const code = editor.locator('pre');
  await code.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Tab');
  await expect(editor).toBeFocused();
  expect(await code.textContent()).toBe('first\n    second');
  await page.keyboard.press('Shift+Tab');
  await expect(editor).toBeFocused();
  expect(await code.textContent()).toBe('first\nsecond');
  await editor.getByText('Ordinary paragraph').click();
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
});
