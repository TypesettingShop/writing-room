import type { Locator, Page } from '@playwright/test';
import { box, drag, expect, test } from './fixtures.js';
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

test('scales the Markdown size presets relative to headings, subtitles, and body text', async ({ appPage: page }) => {
  const name = 'relative-size.md';
  const labels = ['Small', 'Default', 'Large', 'Extra Large'];
  const prefixes = [...Array.from({ length: 6 }, (_, index) => '#'.repeat(index + 1) + ' '), '', ''];
  const blocks = prefixes.flatMap((prefix, index) => ['size-sm', '', 'size-lg', 'size-xl'].map((preset, variant) => {
    const classes = [index === 6 ? 'subtitle' : '', preset].filter(Boolean).map(name => '.' + name).join(' ');
    return `${prefix}Example ${index} ${variant}${classes ? ' {' + classes + '}' : ''}`;
  }));
  const group = await openMarkdown(page, name, blocks.join('\n\n'));
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

  const title = editor.getByRole('heading', { name: 'Example 0 1' });
  const toolbar = group.getByRole('toolbar', { name: 'Markdown formatting' });
  await title.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await toolbar.getByRole('button', { name: 'Size: Default' }).click();
  await page.getByRole('menuitemradio', { name: labels[2], exact: true }).click();
  await expect(title).toHaveCSS('font-size', '40px');
  await toolbar.getByRole('button', { name: 'Size: Large' }).click();
  await page.getByRole('menuitemradio', { name: labels[1], exact: true }).click();
  await expect(title).toHaveCSS('font-size', '32px');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  await toolbar.getByRole('button', { name: 'Size: Default' }).click();
  await page.getByRole('menuitemradio', { name: labels[3], exact: true }).click();
  await expect(title.locator('.size-xl')).toHaveCSS('font-size', '48px');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toContain('# Example 0 [1]{.size-xl}');
  await page.reload();
  await expect(title.locator('.size-xl')).toHaveCSS('font-size', '48px', { timeout: 20_000 });
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
