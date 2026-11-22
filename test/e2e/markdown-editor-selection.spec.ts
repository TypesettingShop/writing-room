import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { runCommand, settingsKey } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { extensionFixtureLocation, seedInstalledExtensions } from './extensionFixture.js';
import { groups, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { box, drag, expect, test } from './fixtures.js';

const cases = [
  { name: 'paragraph', last: 'Last paragraph', selector: 'p', expected: 'Last paragraph added' },
  { name: 'rule', last: '---', selector: 'hr', expected: '---\n\nadded' },
  {
    name: 'HTML literal', last: '<div>Raw HTML</div>', selector: 'p',
    expected: '\\<div>Raw HTML\\</div> added',
  },
  // A link definition exercises the raw_block node in the default parser.
  { name: 'raw block', last: '[ref]: /example', selector: 'pre', expected: '[ref]: /example\n\nadded' },
  { name: 'rule via context menu', last: '---', selector: 'hr', expected: '---\n\nadded', contextMenu: true },
];

for (const { name, last, selector, expected, contextMenu } of cases) {
  test(`typing below a final ${name} preserves the existing Markdown`, async ({ appPage: page }) => {
    const file = `final-${name.replaceAll(' ', '-')}.md`;
    const source = `First paragraph\n\n${last}\n`;
    const inParagraph = selector === 'p';
    await waitForStorage(page);
    await writeWorkspaceFile(page, file, source);
    await treeItem(page, file).dblclick();
    const group = groups(page).first();
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    const lastBlock = editor.locator(selector).last();
    await expect(lastBlock).toBeVisible({ timeout: 20_000 });
    const bounds = await box(lastBlock);
    const paper = await box(editor);

    await page.mouse.click(paper.x + paper.width / 2, bounds.y + bounds.height + 24, {
      button: contextMenu ? 'right' : 'left',
    });
    if (contextMenu) {
      const menu = page.getByRole('menu', { name: 'Markdown editor' });
      await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
    }
    await expect(editor).toBeFocused();
    await expect(selectedTab(group)).toHaveAccessibleDescription('');
    await expect(group.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.keyboard.type(inParagraph ? ' added' : 'added');
    await expect(lastBlock).toBeVisible();
    await expect(editor.locator('p').last()).toHaveText(inParagraph ? `${last} added` : 'added');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, file)).toBe(`First paragraph\n\n${expected}\n`);
  });
}

for (const [side, block, selector, button, final] of [
  ['left', '---', 'hr', 'left', false],
  ['right', '---', 'hr', 'right', false],
  ['left', '[ref]: /example', 'pre', 'right', false],
  ['right', '[ref]: /example', 'pre', 'left', false],
  ['right', '---', 'hr', 'left', true],
] as const) {
  test(`keeps the ${final ? 'final' : 'middle'} atomic ${selector} when typing from its ${side} gutter`, async ({ appPage: page }) => {
    const file = `atomic-${selector}-${side}.md`;
    const tail = final ? '' : '\n\nLast';
    // A previous edit leaves the model with source provenance that includes multiple blank lines.
    await waitForStorage(page);
    await writeWorkspaceFile(page, file, `First\n\n\n\n${block}${tail}\n`);
    await treeItem(page, file).dblclick();
    const group = groups(page).first();
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    await editor.getByText('First', { exact: true }).click({ timeout: 20_000 });
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('ControlOrMeta+s');
    const edited = `First!\n\n\n\n${block}${tail}\n`;
    await expect.poll(() => readWorkspaceText(page, file)).toBe(edited);

    const paper = await box(editor);
    const atom = editor.locator(selector);
    const bounds = await box(atom);
    await page.mouse.click(side === 'left' ? paper.x - 12 : paper.x + paper.width + 12, bounds.y + bounds.height / 2, { button });
    if (button === 'right') {
      const menu = page.getByRole('menu', { name: 'Markdown editor' });
      await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
    }
    await expect(editor).toBeFocused();
    await expect(selectedTab(group)).toHaveAccessibleDescription('');
    await expect(atom).not.toHaveClass(/ProseMirror-selectednode/);
    await page.keyboard.type('Added');
    const inserted = side === 'left' ? `Added\n\n${block}` : `${block}\n\nAdded`;
    await expect(atom).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(async () => (await readWorkspaceText(page, file))?.replace(/\n{3,}/g, '\n\n'))
      .toBe(`First!\n\n${inserted}${tail}\n`);
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, file)).toBe(edited);
  });
}

test('reuses only the current gutter paragraph and leaves the saved source untouched', async ({ appPage: page }) => {
  const file = 'gutter-lifetime.md';
  const source = 'First\n\n---\n\n[ref]: /example\n\nLast\n';
  const group = await openSelectionDocument(page, file, source);
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const rule = editor.locator('hr');
  const definition = editor.locator('pre');
  await expect(rule).toBeVisible({ timeout: 20_000 });

  const clickGutter = async (atom: Locator, side: 'left' | 'right') => {
    const paper = await box(editor);
    const bounds = await box(atom);
    await page.mouse.click(side === 'left' ? paper.x - 12 : paper.x + paper.width + 12, bounds.y + bounds.height / 2);
  };
  for (const [atom, side] of [[rule, 'left'], [definition, 'right'], [rule, 'right'], [definition, 'left']] as const) {
    await clickGutter(atom, side);
    await expect(editor.locator(':scope > p')).toHaveText(['First', '', 'Last']);
  }
  await clickGutter(rule, 'left');
  await page.keyboard.press('ArrowUp');
  await expect(editor.locator(':scope > p')).toHaveText(['First', 'Last']);
  await expect.poll(() => editor.evaluate(element => element.ownerDocument.getSelection()?.focusNode?.textContent)).toBe('First');
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await expect(group.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+s');
  expect(await readWorkspaceText(page, file)).toBe(source);
});

test('redoes the paragraph at the rule after undo and a caret move', async ({ appPage: page }) => {
  const file = 'gutter-redo.md';
  const source = 'First\n\n---\n\nLast\n';
  const group = await openSelectionDocument(page, file, source);
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const rule = editor.locator('hr');
  await expect(rule).toBeVisible({ timeout: 20_000 });
  const paper = await box(editor);
  const bounds = await box(rule);
  await page.mouse.click(paper.x + paper.width + 12, bounds.y + bounds.height / 2);
  await page.keyboard.type('Added');
  await expect(editor.locator('hr + p')).toHaveText('Added');
  await page.keyboard.press('ControlOrMeta+z');
  await editor.getByText('Last', { exact: true }).click();
  await expect(editor.locator(':scope > p')).toHaveText(['First', 'Last']);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, file)).toBe(source);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('hr + p')).toHaveText('Added');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, file)).toBe('First\n\n---\n\nAdded\n\nLast\n');
});

for (const keepRule of [true, false]) {
  test(`places input after a split source edit that ${keepRule ? 'keeps' : 'deletes'} the target rule`, async ({ appPage: page }) => {
    const file = 'gutter-split-source.md';
    const left = await openSelectionDocument(page, file, 'First\n\n---');
    const editor = left.getByRole('textbox', { name: 'Markdown editor' });
    const rule = editor.locator('hr');
    await expect(rule).toBeVisible({ timeout: 20_000 });
    await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
    const right = groups(page).nth(1);
    await right.getByRole('button', { name: 'Switch to Markdown Source' }).click();
    const source = right.getByRole('textbox', { name: 'Editor content' });
    await expect(source).toBeFocused({ timeout: 20_000 });

    const paper = await box(editor);
    const bounds = await box(rule);
    await page.mouse.click(paper.x + paper.width / 2, bounds.y + bounds.height + 24);
    await expect(editor.locator(':scope > p')).toHaveText(['First', '']);
    await expect(selectedTab(left)).toHaveAccessibleDescription('');
    await source.focus();
    if (keepRule) {
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.insertText('Changed ');
      await expect(editor.locator(':scope > p')).toHaveText(['Changed First', '']);
    } else {
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Shift+Home');
      await page.keyboard.press('Backspace');
      await expect(rule).toHaveCount(0);
      await expect(editor.locator(':scope > p')).toHaveText(['First']);
    }

    await editor.focus();
    await page.keyboard.type('Added');
    await expect(editor.locator(':scope > p')).toHaveText(keepRule ? ['Changed First', 'Added'] : ['FirstAdded']);
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, file))
      .toBe(keepRule ? 'Changed First\n\n---\n\nAdded' : 'FirstAdded\n\n');
  });
}

test('typing still replaces an explicitly selected Markdown rule', async ({ appPage: page }) => {
  await waitForStorage(page);
  await writeWorkspaceFile(page, 'selected-rule.md', 'First paragraph\n\n---\n');
  await treeItem(page, 'selected-rule.md').dblclick();
  const editor = groups(page).first().getByRole('textbox', { name: 'Markdown editor' });
  const rule = editor.locator('hr');
  await rule.click({ modifiers: ['ControlOrMeta'], timeout: 20_000 });
  await expect(rule).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.type('Replacement');
  await expect(rule).toHaveCount(0);
  await expect(editor.locator('p')).toHaveText(['First paragraph', 'Replacement']);
});

test('clicking below a final rule keeps edited gaps and the source caret after the rule', async ({ appPage: page }) => {
  const file = 'edited-gaps.md';
  await waitForStorage(page);
  await writeWorkspaceFile(page, file, 'First\n\n\n\nSecond\n\n---\n');
  await treeItem(page, file).dblclick();
  const group = groups(page).first();
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  await editor.getByText('First', { exact: true }).click({ timeout: 20_000 });
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, file)).toBe('First!\n\n\n\nSecond\n\n---\n');
  const rule = await box(editor.locator('hr'));
  const paper = await box(editor);
  await page.mouse.click(paper.x + paper.width / 2, rule.y + rule.height + 24);
  await expect(editor).toBeFocused();
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await page.keyboard.type('added');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, file)).toBe('First!\n\n\n\nSecond\n\n---\nadded');
});

test('drops the display-only paragraph during a round trip through source mode', async ({ appPage: page }) => {
  const file = 'gutter-mode-switch.md';
  const source = 'First\n\n---\n';
  const group = await openSelectionDocument(page, file, source);
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const rule = editor.locator('hr');
  await expect(rule).toBeVisible({ timeout: 20_000 });
  const paper = await box(editor);
  const bounds = await box(rule);
  await page.mouse.click(paper.x + paper.width / 2, bounds.y + bounds.height + 24);
  await expect(editor.locator(':scope > p')).toHaveText(['First', '']);

  await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await expect(editor).toBeFocused({ timeout: 20_000 });
  await expect(editor.locator(':scope > p')).toHaveText(['First']);
  await expect(group.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(selectedTab(group)).toHaveAccessibleDescription('');
  await page.keyboard.press('ControlOrMeta+s');
  expect(await readWorkspaceText(page, file)).toBe(source);
});

async function textPoint(line: Locator, offset: number): Promise<{ x: number; y: number }> {
  return line.evaluate((element, offset) => {
    const range = element.ownerDocument.createRange();
    range.setStart(element.firstChild!, offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, offset);
}

async function openSelectionDocument(page: Page, file: string, source: string): Promise<Locator> {
  await waitForStorage(page);
  await writeWorkspaceFile(page, file, source);
  await treeItem(page, file).dblclick();
  return groups(page).first();
}

test('drags and double-clicks to select text from the editor padding', async ({ appPage: page }) => {
  const group = await openSelectionDocument(page, 'padding-selection.md', 'Alpha words here\n\nBeta words here\n');
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const first = editor.getByText('Alpha words here', { exact: true });
  const second = editor.getByText('Beta words here', { exact: true });
  await expect(first).toBeVisible({ timeout: 20_000 });

  const paper = await box(editor);
  const start = await textPoint(first, 0);
  const end = await textPoint(first, 'Alpha words'.length);
  const paddingX = (paper.x + start.x) / 2;
  const selection = () => editor.evaluate(() => document.getSelection()?.toString());
  await drag(page, paddingX, start.y, end.x, end.y);
  await expect.poll(selection).toBe('Alpha words');

  const next = await textPoint(second, 0);
  await page.mouse.dblclick(paddingX, next.y);
  await expect.poll(selection).toBe('Beta');
});

for (const [name, nested, selector] of [
  ['quote', '> ---', 'blockquote hr'],
  ['list', '- Item\n\n  ---', 'li hr'],
] as const) {
  test(`keeps a ${name} rule and types just after its container from the gutter`, async ({ appPage: page }) => {
    const file = `nested-${name}-rule.md`;
    const group = await openSelectionDocument(page, file, `${nested}\n\n---\n\nLast\n`);
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    const rule = editor.locator(selector);
    await expect(rule).toBeVisible({ timeout: 20_000 });
    const paper = await box(editor);
    const bounds = await box(rule);
    await page.mouse.click(paper.x + paper.width + 12, bounds.y + bounds.height / 2);
    await expect(selectedTab(group)).toHaveAccessibleDescription('');
    await page.keyboard.type('Added');
    await expect(rule).toBeVisible();
    await expect(editor.locator(':scope > p')).toHaveText(['Added', 'Last']);
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, file)).toBe(`${nested}\n\nAdded\n\n---\n\nLast\n`);
  });
}

test('keeps pending bold when the same caret is clicked in the gutter', async ({ appPage: page }) => {
  const group = await openSelectionDocument(page, 'gutter-marks.md', 'Line\n');
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const paragraph = editor.getByText('Line', { exact: true });
  await paragraph.click({ timeout: 20_000 });
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+b');
  const bold = group.getByRole('toolbar', { name: 'Markdown formatting' }).getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');

  const paper = await box(editor);
  const bounds = await box(paragraph);
  await page.mouse.click(paper.x + paper.width + 12, bounds.y + bounds.height / 2);
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('Bold');
  await expect(editor.locator('strong')).toHaveText('Bold');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, 'gutter-marks.md')).toBe('Line**Bold**\n');
});

for (const [name, before, expected] of [
  ['middle', 'First\n\n', 'FirstZ\n\n---\n\nLast\n'],
  ['first', '', '---\n\nZLast\n'],
] as const) {
  test(`source typing after a caret beside the ${name} rule preserves the rule`, async ({ appPage: page }) => {
    const file = `source-caret-${name}-rule.md`;
    const source = `${before}---\n\nLast\n`;
    const group = await openSelectionDocument(page, file, source);
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    const rule = editor.locator('hr');
    await expect(rule).toBeVisible({ timeout: 20_000 });
    const paper = await box(editor);
    const bounds = await box(rule);
    await page.mouse.click(paper.x - 12, bounds.y + bounds.height / 2);
    await expect(selectedTab(group)).toHaveAccessibleDescription('');
    await group.getByRole('button', { name: 'Switch to Markdown Source' }).click();
    await expect(group.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
    await page.keyboard.type('Z');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, file)).toBe(expected);
  });
}

test('right-clicking below a read-only rule leaves a collapsed selection', async ({ appPage: page }) => {
  await seedInstalledExtensions(page, [{
    manifest: JSON.parse(readFileSync(new URL('../fixtures/extensions/memfs/package.json', import.meta.url), 'utf8')),
    location: extensionFixtureLocation('memfs'),
  }]);
  await page.reload();
  await runCommand(page, 'Open Read-only Rule Fixture', /^Open Read-only Rule Fixture$/);
  const group = groups(page).first();
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const atom = editor.locator('hr');
  await expect(atom).toBeVisible({ timeout: 20_000 });
  const bounds = await box(atom);
  const editorBounds = await box(editor);
  await page.mouse.click(editorBounds.x - 12, bounds.y + bounds.height / 2);
  await expect(editor).toBeFocused();
  await expect(editor.locator(':scope > p')).toHaveCount(0);
  expect((await box(atom)).y).toBe(bounds.y);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height + 24, { button: 'right' });

  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeDisabled();
  await expect(atom).not.toHaveClass(/ProseMirror-selectednode/);
  await expect.poll(() => editor.evaluate(element => element.ownerDocument.getSelection()?.isCollapsed)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Blocked');
  await expect(atom).toBeVisible();
  await expect(editor).not.toContainText('Blocked');
  await expect(selectedTab(group)).toHaveAccessibleDescription('Read-only');
  await expect(editor.locator(':scope > p')).toHaveCount(0);
  expect((await box(editor)).height).toBe(editorBounds.height);
});

test('selects and copies read-only Markdown with the mouse without moving the typewriter viewport', async ({ appPage: page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ 'markdownEditor.typewriterScroll': true }));
  }, settingsKey);
  await seedInstalledExtensions(page, [{
    manifest: JSON.parse(readFileSync(new URL('../fixtures/extensions/memfs/package.json', import.meta.url), 'utf8')),
    location: extensionFixtureLocation('memfs'),
  }]);
  await page.reload();
  const fixture = 'Open Read-only Typewriter Fixture';
  await runCommand(page, fixture, new RegExp(`^${fixture}$`));
  const group = groups(page).first();
  const editor = group.getByRole('textbox', { name: 'Markdown editor' });
  const surface = group.locator('.markdown-editor-surface');
  const first = editor.getByText('Line 3', { exact: true });
  const last = editor.getByText('Line 4', { exact: true });
  await expect(first).toBeVisible({ timeout: 20_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(surface).toHaveClass(/markdown-typewriter/);

  const scrollTop = await surface.evaluate(async element => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const line = element.querySelectorAll('p')[2].getBoundingClientRect();
    element.scrollTop += line.top - element.getBoundingClientRect().top - element.clientHeight / 8;
    return element.scrollTop;
  });
  const selection = () => editor.evaluate(() => document.getSelection()?.toString());
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const word = await textPoint(first, 2);
  await page.mouse.dblclick(word.x, word.y);
  await expect.poll(selection).toBe('Line');
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(clipboard).toBe('Line');

  expect(await surface.evaluate(element => element.scrollTop)).toBe(scrollTop);

  // Start outside the selected word so Chromium starts a new range.
  const start = await textPoint(first, 5);
  const end = await textPoint(last, 4);
  await drag(page, start.x, start.y, end.x, end.y);
  const range = '3\n\nLine';
  await expect.poll(selection).toBe(range);
  await page.mouse.click(end.x - 3, end.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Markdown editor' });
  const copy = menu.getByRole('menuitem', { name: 'Copy', exact: true });
  await expect(copy).toBeEnabled();
  for (const name of ['Cut', 'Paste', 'Paste as Plain Text']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeDisabled();
  }
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Bold' })).toBeDisabled();
  await expect.poll(selection).toBe(range);
  await copy.click();
  await expect.poll(clipboard).toBe(range);
  expect(await surface.evaluate(element => element.scrollTop)).toBe(scrollTop);

  // The gutter cannot take focus itself, so a press there keeps the read-only document focused.
  const paper = await box(editor);
  await page.mouse.click(paper.x - 12, end.y);
  await expect(editor).toBeFocused();
  await expect.poll(selection).toBe('');
});
