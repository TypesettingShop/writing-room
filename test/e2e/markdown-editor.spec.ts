import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { runCommand, settingsKey, startWithMarkdownSource } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { groups, listBackups, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { chooseTheme } from './themes.helpers.js';

const richEditor = (scope: Locator) => scope.getByRole('textbox', { name: 'Markdown editor' });

async function openMarkdown(page: Page, name: string, text: string): Promise<Locator> {
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, text);
  await treeItem(page, name).dblclick();
  return groups(page).first();
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
  const style = toolbar.getByRole('button', { name: /^Style/ });
  await expect(style).toHaveAccessibleName('Style: Body');
  await style.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Style' });
  await expect(menu.getByRole('menuitemradio', { name: 'Body' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(style).toBeFocused();
  await expect(editor.getByRole('heading', { name: 'First', level: 2 })).toBeVisible();
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
  const group = await openMarkdown(page, name, 'One word {.my-class}\n\nSubheading {.subtitle .font-sans}');
  const editor = richEditor(group);
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  const paragraph = editor.locator('p.my-class');
  await paragraph.click({ timeout: 20_000 });
  await toolbar.getByRole('button', { name: 'Align: Left' }).click();
  await page.getByRole('menuitemradio', { name: 'Center', exact: true }).click();
  await expect(paragraph).toHaveCSS('text-align', 'center');
  await expect(toolbar.getByRole('button', { name: 'Align: Center' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+l');
  await expect(paragraph).toHaveCSS('text-align', 'start');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(paragraph).toHaveCSS('text-align', 'center');
  await expect(editor).toBeFocused();

  await editor.focus();
  await page.keyboard.press('End');
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await toolbar.getByRole('button', { name: 'Size: Default' }).click();
  await page.getByRole('menuitemradio', { name: 'Large', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Font: Default' }).click();
  await page.getByRole('menuitemradio', { name: 'Serif', exact: true }).click();
  const span = paragraph.locator('span.size-lg.font-serif');
  await expect(span).toHaveText('word');
  await expect(span).toHaveCSS('font-size', '20px');
  await expect(span).toHaveCSS('font-family', 'Cambria, serif');
  await expect(editor.locator('.subtitle')).toHaveCSS('color', 'rgb(90, 101, 119)');
  await expect(editor.locator('.subtitle')).toHaveCSS('font-family', 'system-ui, sans-serif');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  expect(await readWorkspaceText(page, name)).toBe(
    'One [word]{.size-lg .font-serif} {.my-class .center}\n\nSubheading {.subtitle .font-sans}',
  );
  await page.reload();
  await expect(paragraph).toHaveCSS('text-align', 'center', { timeout: 20_000 });
  await expect(span).toHaveText('word');
  await expect(span).toHaveCSS('font-family', 'Cambria, serif');
  await chooseTheme(page, 'Writing Room Dark');
  await expect(editor.locator('.subtitle')).toHaveCSS('color', 'rgb(167, 182, 203)');
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

  await left.getByRole('button', { name: 'Style: Body' }).click();
  await page.getByRole('menuitemradio', { name: 'Heading 2' }).click();
  await expect(leftEditor.getByRole('heading', { name: 'Left editor', level: 2 })).toBeVisible();
  await expect(rightEditor.locator('p')).toHaveText('Right editor');
  await expect(right.getByRole('button', { name: 'Style: Body' })).toBeVisible();
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
