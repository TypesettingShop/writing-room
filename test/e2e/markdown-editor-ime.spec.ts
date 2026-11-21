import { expect, test } from './fixtures.js';
import { runCommand } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { groups, readWorkspaceText, waitForStorage, writeWorkspaceFile } from './files.helpers.js';

for (const action of ['click', 'Tab', 'toolbar', 'window blur', 'save', 'mode switch'] as const) {
  test(`preserves the final Hangul composition on ${action}`, async ({ appPage: page }) => {
    const name = 'hangul.md';
    await waitForStorage(page);
    await writeWorkspaceFile(page, name, '안녕하세\n\nClick here');
    await treeItem(page, name).dblclick();
    const group = groups(page).first();
    const editor = group.getByRole('textbox', { name: 'Markdown editor' });
    const first = editor.locator('p').first();
    await expect(first).toHaveText('안녕하세', { timeout: 20_000 });
    const source = groups(page).nth(1);
    if (action === 'click') {
      await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
      await source.getByRole('button', { name: 'Switch to Markdown Source' }).click();
      await expect(source.locator('.view-lines')).toContainText('안녕하세', { timeout: 20_000 });
    }

    await first.click();
    await page.keyboard.press('End');
    await editor.evaluate(element => {
      element.addEventListener('compositionend', event => {
        document.documentElement.dataset.testCompositionEnd = (event as CompositionEvent).data;
      }, { once: true });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ㅇ', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
    await expect(first).toHaveText('안녕하세요');

    switch (action) {
      case 'click':
        await editor.getByText('Click here').click({ position: { x: 1, y: 5 } });
        // Chromium would still replace its old composing range if the click only moved the PM selection.
        await cdp.send('Input.insertText', { text: 'X' });
        await expect(first).toHaveText('안녕하세요');
        await expect(editor.locator('p').last()).toHaveText('XClick here');
        await expect(source.locator('.view-lines')).toContainText('안녕하세요');
        await expect(source.locator('.view-lines')).toContainText('XClick here');
        break;
      case 'Tab':
        await page.keyboard.press('Tab');
        await expect(editor).not.toBeFocused();
        break;
      case 'toolbar': {
        const bold = group.getByRole('button', { name: 'Bold', exact: true });
        await bold.click();
        await expect(bold).toHaveAttribute('aria-pressed', 'true');
        await expect(editor).toBeFocused();
        break;
      }
      case 'window blur':
        // Headless Chromium keeps the test page focused even after another tab is brought forward.
        await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
        await expect(editor).toBeFocused();
        break;
      case 'save':
        await page.keyboard.press('ControlOrMeta+s');
        break;
      case 'mode switch':
        await page.keyboard.press('ControlOrMeta+Shift+m');
        await expect(group.locator('.view-lines')).toContainText('안녕하세요');
        break;
    }
    await expect(page.locator('html')).toHaveAttribute('data-test-composition-end', '요');
    if (action !== 'save') await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, name)).toBe(
      '안녕하세요\n\n' + (action === 'click' ? 'XClick here' : 'Click here'),
    );
  });
}
