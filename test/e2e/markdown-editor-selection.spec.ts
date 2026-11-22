import { treeItem } from './explorer.helpers.js';
import { groups, readWorkspaceText, selectedTab, waitForStorage, writeWorkspaceFile } from './files.helpers.js';
import { box, expect, test } from './fixtures.js';

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
