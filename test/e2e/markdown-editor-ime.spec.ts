import type { Locator, Page } from '@playwright/test';
import { box, expect, test } from './fixtures.js';
import { runCommand } from './configuration.helpers.js';
import { treeItem } from './explorer.helpers.js';
import { groups, readWorkspaceText, waitForStorage, writeWorkspaceFile } from './files.helpers.js';

/** Change the source before ProseMirror records Chromium's native DOM mutation. */
async function editSourceOnComposition(
  editor: Locator, name: string, range: [number, number, number, number], text = '',
): Promise<void> {
  await editor.evaluate(async (element, { name, range, text }) => {
    const modulePath = '/src/editor/browser/monaco.ts';
    const { loadMonaco } = await import(modulePath) as typeof import('../../src/editor/browser/monaco.js');
    const monaco = await loadMonaco();
    const model = monaco.editor.getModels().find(candidate => candidate.uri.path.endsWith('/' + name))!;
    const onInput = (event: Event) => {
      if (!event.isTrusted || (event as InputEvent).inputType !== 'insertCompositionText') return;
      element.removeEventListener('input', onInput, true);
      model.applyEdits([{ range: new monaco.Range(...range), text }]);
    };
    element.addEventListener('input', onInput, true);
  }, { name, range, text });
}

async function openCompositionSplit(page: Page, name: string, original: string, editContext: boolean): Promise<Locator> {
  if (!editContext) {
    await page.addInitScript(() => Object.defineProperty(window, 'EditContext', { value: undefined }));
    await page.reload();
  }
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, original);
  await treeItem(page, name).dblclick();
  const editor = groups(page).first().getByRole('textbox', { name: 'Markdown editor' });
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const source = groups(page).nth(1);
  await source.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(source.locator(editContext ? '.native-edit-context' : 'textarea.inputarea')).toBeFocused({ timeout: 20_000 });
  return editor;
}

test('restores the last Hangul syllable deleted by an IME reset before a click', async ({ appPage: page }) => {
  const name = 'hangul-reset.md';
  await waitForStorage(page);
  await writeWorkspaceFile(page, name, '안녕하세\n\nClick here');
  await treeItem(page, name).dblclick();
  const editor = groups(page).first().getByRole('textbox', { name: 'Markdown editor' });
  const first = editor.locator('p').first();
  const second = editor.locator('p').last();
  await expect(first).toHaveText('안녕하세', { timeout: 20_000 });
  await runCommand(page, 'Split Editor Right', /^View: Split Editor Right$/);
  const source = groups(page).nth(1);
  await source.getByRole('button', { name: 'Switch to Markdown Source' }).click();
  await expect(source.locator('.view-lines')).toContainText('안녕하세', { timeout: 20_000 });

  await first.click();
  await page.keyboard.press('End');
  await editor.evaluate(element => {
    const updateComposition = (data: string) => {
      element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data }));
      const input = { bubbles: true, inputType: 'insertCompositionText', data, isComposing: true };
      element.dispatchEvent(new InputEvent('beforeinput', input));
      // Synthetic events do not apply the browser's native edit.
      const text = element.querySelector('p')!.firstChild as Text;
      text.data = '안녕하세' + data;
      document.getSelection()!.collapse(text, text.length);
      element.dispatchEvent(new InputEvent('input', input));
    };
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    updateComposition('요');
    // The OS removes the composing text before the pointer event reaches the editor.
    window.addEventListener('pointerdown', () => {
      updateComposition('');
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    }, { capture: true, once: true });
  });
  await expect(source.locator('.view-lines')).toContainText('안녕하세요');
  await second.click({ position: { x: 1, y: 5 } });
  await expect(first).toHaveText('안녕하세요');
  await expect.poll(() => second.evaluate(paragraph => {
    const selection = paragraph.ownerDocument.getSelection();
    return selection?.anchorOffset === 0 && paragraph.contains(selection.anchorNode);
  })).toBe(true);
  await page.keyboard.insertText('X');
  await expect(first).toHaveText('안녕하세요');
  await expect(second).toHaveText('XClick here');
  await expect(source.locator('.view-lines')).toContainText('XClick here');
  await expect(source.locator('.view-lines')).toContainText('안녕하세요');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readWorkspaceText(page, name)).toBe('안녕하세요\n\nXClick here');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(second).toHaveText('Click here');
  await expect(first).toHaveText('안녕하세요');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(first).toHaveText('안녕하세');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(first).toHaveText('안녕하세요');
  await expect(second).toHaveText('Click here');
});

for (const editContext of [true, false]) {
  test(`keeps native composition when a source edit deletes its gutter target (${editContext ? 'EditContext' : 'textarea'})`,
    async ({ appPage: page }) => {
      test.skip(process.env.E2E_TARGET === 'preview', 'The test needs the dev module to apply a synchronous Monaco model edit.');
      const name = 'hangul-deleted-gutter.md';
      const original = 'First\n\n---\n\nLast';
      const external = 'First\n\nLast';
      const recovered = 'First\n\n요\n\nLast';
      const editor = await openCompositionSplit(page, name, original, editContext);
      const rule = editor.locator('hr');
      await expect(rule).toBeVisible({ timeout: 20_000 });

      const paper = await box(editor);
      const atom = await box(rule);
      await page.mouse.click(paper.x + 12, atom.y + atom.height / 2);
      const paragraphs = editor.locator(':scope > p');
      await expect(paragraphs).toHaveText(['First', '', 'Last']);

      await editSourceOnComposition(editor, name, [3, 1, 5, 1]);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
      await expect(rule).toHaveCount(0);
      await expect(paragraphs).toHaveText(['First', '요', 'Last']);
      await expect.poll(() => paragraphs.nth(1).evaluate(paragraph => {
        const selection = paragraph.ownerDocument.getSelection();
        return selection?.focusOffset === 1 && paragraph.contains(selection.focusNode);
      })).toBe(true);
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readWorkspaceText(page, name)).toBe(recovered);

      await page.keyboard.press('ControlOrMeta+z');
      await expect(paragraphs).toHaveText(['First', 'Last']);
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readWorkspaceText(page, name)).toBe(external);
      await page.keyboard.press('ControlOrMeta+z');
      await expect(rule).toBeVisible();
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readWorkspaceText(page, name)).toBe(original);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(paragraphs).toHaveText(['First', 'Last']);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(paragraphs).toHaveText(['First', '요', 'Last']);
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readWorkspaceText(page, name)).toBe(recovered);
    },
  );

  for (const survives of [true, false]) {
    test(`${survives ? 'keeps' : 'recovers'} native composition for a ${survives ? 'surviving' : 'deleted'} duplicate list item (${editContext ? 'EditContext' : 'textarea'})`,
      async ({ appPage: page }) => {
        test.skip(process.env.E2E_TARGET === 'preview', 'The test needs the dev module to apply a synchronous Monaco model edit.');
        const name = 'hangul-duplicate-list-items.md';
        const original = '- Bravo\n- Alpha\n- Bravo';
        const external = '- Bravo';
        // The deleted item is selected in full. The new preedit shares its prefix, which PM's
        // document diff can leave out of the replacement step.
        const preedit = survives ? '요' : 'Bravo요';
        const expectedItem = survives ? 'Bravo요' : 'Bravo';
        const expectedSource = survives ? '- Bravo요' : '- Bravo\n\n' + preedit;
        const editor = await openCompositionSplit(page, name, original, editContext);
        const items = editor.locator('li');
        const recovered = editor.locator(':scope > p');
        await expect(items).toHaveText(['Bravo', 'Alpha', 'Bravo'], { timeout: 20_000 });

        await items.nth(survives ? 2 : 0).click();
        await page.keyboard.press('End');
        if (!survives) await page.keyboard.press('Shift+Home');
        await editSourceOnComposition(editor, name, [1, 1, 3, 1]);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.imeSetComposition', { text: preedit, selectionStart: preedit.length, selectionEnd: preedit.length });
        await expect(items).toHaveText([expectedItem]);
        if (!survives) await expect(recovered).toHaveText(preedit);
        const target = survives ? items.first() : recovered;
        const expectCaret = () => expect.poll(() => target.evaluate(textBlock => {
          const selection = textBlock.ownerDocument.getSelection();
          return textBlock.contains(selection?.focusNode ?? null) && selection?.focusOffset === textBlock.textContent?.length;
        })).toBe(true);
        await expectCaret();
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => readWorkspaceText(page, name)).toBe(expectedSource);

        await page.keyboard.press('ControlOrMeta+z');
        await expect(items).toHaveText(['Bravo']);
        await expect(recovered).toHaveCount(0);
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => readWorkspaceText(page, name)).toBe(external);
        await page.keyboard.press('ControlOrMeta+z');
        await expect(items).toHaveText(['Bravo', 'Alpha', 'Bravo']);
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => readWorkspaceText(page, name)).toBe(original);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(items).toHaveText(['Bravo']);
        await expect(recovered).toHaveCount(0);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(items).toHaveText([expectedItem]);
        if (!survives) await expect(recovered).toHaveText(preedit);
        await expectCaret();
        await page.keyboard.press('ControlOrMeta+s');
        await expect.poll(() => readWorkspaceText(page, name)).toBe(expectedSource);
      },
    );
  }

  for (const scenario of [
    {
      label: 'a partial source edit in the same table cell',
      original: '| Alpha | Bravo |', external: '| ALpha | Bravo |', composed: '| ALpha요 | Bravo |',
      range: [3, 4, 3, 5], replacement: 'L', target: 0,
      initialCells: ['Alpha', 'Bravo'], externalCells: ['ALpha', 'Bravo'], composedCells: ['ALpha요', 'Bravo'],
    },
    {
      label: 'a source edit beside an auto-filled table cell',
      original: '| Alpha |', external: '| Zulu |', composed: '| Zulu | 요 |',
      range: [3, 3, 3, 8], replacement: 'Zulu', target: 1,
      initialCells: ['Alpha', ''], externalCells: ['Zulu', ''], composedCells: ['Zulu', '요'],
    },
  ] as const) {
    test(`keeps native composition through ${scenario.label} (${editContext ? 'EditContext' : 'textarea'})`,
      async ({ appPage: page }) => {
        test.skip(process.env.E2E_TARGET === 'preview', 'The test needs the dev module to apply a synchronous Monaco model edit.');
        const name = 'hangul-table-cell.md';
        const header = '| A | B |\n| --- | --- |\n';
        const editor = await openCompositionSplit(page, name, header + scenario.original, editContext);
        const cells = editor.locator('tbody td');
        const cell = cells.nth(scenario.target);
        await expect(cells).toHaveText([...scenario.initialCells]);
        await cell.click();
        await page.keyboard.press('End');
        await editSourceOnComposition(editor, name, [...scenario.range], scenario.replacement);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
        const expectCaret = () => expect.poll(() => cell.evaluate(element => {
          const selection = element.ownerDocument.getSelection();
          return element.contains(selection?.focusNode ?? null) && selection?.focusOffset === element.textContent?.length;
        })).toBe(true);
        const expectVersion = async (source: string, content: readonly string[]) => {
          await expect(cells).toHaveText([...content]);
          await page.keyboard.press('ControlOrMeta+s');
          await expect.poll(() => readWorkspaceText(page, name)).toBe(header + source);
        };
        await expectVersion(scenario.composed, scenario.composedCells);
        await expectCaret();
        await page.keyboard.press('ControlOrMeta+z');
        await expectVersion(scenario.external, scenario.externalCells);
        await page.keyboard.press('ControlOrMeta+z');
        await expectVersion(scenario.original, scenario.initialCells);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expectVersion(scenario.external, scenario.externalCells);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expectVersion(scenario.composed, scenario.composedCells);
        await expectCaret();
      },
    );
  }
}

for (const action of [
  'click', 'Tab', 'toolbar', 'window blur', 'save', 'mode switch', 'link', 'image', 'context toolbox', 'context menu key',
] as const) {
  test(`preserves the final Hangul composition on ${action}`, async ({ appPage: page }) => {
    const name = 'hangul.md';
    await waitForStorage(page);
    if (action === 'image') {
      await writeWorkspaceFile(page, 'photo.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    }
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
        document.documentElement.dataset.testQuickInputAtCompositionEnd =
          String(document.querySelector('.wr-quick-input-box') !== null);
        document.documentElement.dataset.testContextMenuAtCompositionEnd =
          String(document.querySelector('.wr-menu[aria-label="Markdown editor"]') !== null);
      }, { once: true });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ㅇ', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: action === 'context toolbox' ? 0 : 1, selectionEnd: 1 });
    await expect(first).toHaveText('안녕하세요');

    let savedFirst = '안녕하세요';
    let savedLast = 'Click here';
    switch (action) {
      case 'click':
        await editor.getByText('Click here').click({ position: { x: 1, y: 5 } });
        // Chromium would still replace its old composing range if the click only moved the PM selection.
        await cdp.send('Input.insertText', { text: 'X' });
        await expect(first).toHaveText('안녕하세요');
        await expect(editor.locator('p').last()).toHaveText('XClick here');
        await expect(source.locator('.view-lines')).toContainText('안녕하세요');
        await expect(source.locator('.view-lines')).toContainText('XClick here');
        savedLast = 'XClick here';
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
      case 'context toolbox': {
        await expect.poll(() => editor.evaluate(() => document.getSelection()?.toString())).toBe('요');
        const point = await editor.evaluate(() => {
          const rect = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await page.mouse.click(point.x, point.y, { button: 'right' });
        const menu = page.getByRole('menu', { name: 'Markdown editor' });
        await expect(menu).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-test-composition-end', '요');
        await expect(page.locator('html')).toHaveAttribute('data-test-context-menu-at-composition-end', 'false');
        await expect(menu.getByRole('menuitem', { name: 'Undo' })).toBeEnabled();
        await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeEnabled();
        await menu.getByRole('menuitemcheckbox', { name: 'Underline' }).click();
        await expect(first.locator('u.underline')).toHaveText('요');
        await expect(editor).toBeFocused();
        savedFirst = '안녕하세[요]{.underline}';
        break;
      }
      case 'context menu key': {
        await page.keyboard.press('Shift+F10');
        const menu = page.getByRole('menu', { name: 'Markdown editor' });
        await expect(menu.getByRole('menuitem', { name: 'Undo' })).toBeFocused();
        await expect(menu.getByRole('group')).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute('data-test-composition-end', '요');
        await expect(page.locator('html')).toHaveAttribute('data-test-context-menu-at-composition-end', 'false');
        await page.keyboard.press('Escape');
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
      case 'link': {
        const editLink = group.getByRole('button', { name: 'Edit Link' });
        await editLink.click();
        const url = page.getByRole('textbox', { name: 'Edit Link' });
        await expect(url).toBeFocused();
        await expect(page.locator('html')).toHaveAttribute('data-test-quick-input-at-composition-end', 'false');
        await url.fill('/other.md');
        await url.press('Enter');
        const link = first.getByRole('link', { name: '/other.md' });
        await expect(link).toHaveAttribute('href', '/other.md');
        await expect(first).toHaveText('안녕하세요/other.md');

        await link.click();
        await editLink.click();
        await expect(url).toHaveValue('/other.md');
        await url.fill('/discarded.md');
        await url.press('Escape');
        await expect(link).toHaveAttribute('href', '/other.md');
        savedFirst += '[/other.md](/other.md)';
        break;
      }
      case 'image': {
        await group.getByRole('button', { name: 'Image', exact: true }).click();
        const address = page.getByRole('textbox', { name: 'Image Address' });
        await expect(address).toBeFocused();
        await expect(page.locator('html')).toHaveAttribute('data-test-quick-input-at-composition-end', 'false');
        await address.fill('photo.svg');
        await address.press('Enter');
        const description = page.getByRole('textbox', { name: 'Image Description' });
        await description.fill('Photo');
        await description.press('Enter');
        await expect(first.getByRole('img', { name: 'Photo' })).toHaveAttribute('src', /^blob:/);
        await expect(first).toHaveText('안녕하세요');
        savedFirst += '![Photo](photo.svg)';
        break;
      }
    }
    await expect(page.locator('html')).toHaveAttribute('data-test-composition-end', '요');
    if (action !== 'save') await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readWorkspaceText(page, name)).toBe(`${savedFirst}\n\n${savedLast}`);
  });
}
