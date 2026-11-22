import { readFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
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

async function textPoint(line: Locator, offset: number): Promise<{ x: number; y: number }> {
  return line.evaluate((element, offset) => {
    const range = element.ownerDocument.createRange();
    range.setStart(element.firstChild!, offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, offset);
}

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
});
