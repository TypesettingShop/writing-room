import type { Locator, Page } from '@playwright/test';
import { box, expect, renderedText, test } from './fixtures.js';

test.use({ viewport: { width: 1280, height: 800 } });

const parts = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);
const tabNames = (group: Locator) => group.getByRole('tablist', { name: 'Open Editors' }).getByRole('tab');
const tab = (group: Locator, name: string) => group.getByRole('tab', { name, exact: true });
const selected = (group: Locator) => group.getByRole('tab', { selected: true });
const draft = 'IntegrationDraft';
const settingsText = '{"editor.fontSize": 24}';

async function palette(page: Page, query: string): Promise<Locator> {
  await page.keyboard.press('F1');
  const input = page.getByRole('combobox', { name: 'Type a command' });
  await expect(input).toBeFocused();
  await input.fill(query);
  return input;
}

async function command(page: Page, query: string, name: RegExp): Promise<void> {
  await palette(page, query);
  await page.getByRole('option', { name }).click();
}

async function dragTo(
  page: Page, source: Locator, target: { x: number; y: number }, indicator: Locator, attribute: string, value: string,
): Promise<void> {
  const from = await box(source);
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 3, { steps: 3 });
  // Chromium needs another move over the target to dispatch dragover after dragenter.
  await page.mouse.move(target.x - 1, target.y);
  await page.mouse.move(target.x, target.y);
  await expect(indicator).toHaveAttribute(attribute, value);
  await page.mouse.up();
  await expect(page.locator(`[${attribute}]`)).toHaveCount(0);
}

async function groupPoint(group: Locator, x: number, y: number) {
  const bounds = await box(group);
  const strip = await box(group.getByRole('tablist', { name: 'Open Editors' }));
  const top = strip.y + strip.height;
  return { x: bounds.x + bounds.width * x, y: top + (bounds.y + bounds.height - top) * y };
}

async function expectTiled(editor: Locator, first: Locator, second: Locator, direction: 'horizontal' | 'vertical') {
  const [area, a, b] = await Promise.all([box(editor), box(first), box(second)]);
  const [axis, length, crossAxis, crossLength] = direction === 'horizontal'
    ? ['x', 'width', 'y', 'height'] as const
    : ['y', 'height', 'x', 'width'] as const;
  const samePixel = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
  samePixel(a[axis], area[axis]);
  samePixel(a[axis] + a[length], b[axis]);
  samePixel(b[axis] + b[length], area[axis] + area[length]);
  for (const group of [a, b]) {
    expect(group.width).toBeGreaterThanOrEqual(220);
    expect(group.height).toBeGreaterThanOrEqual(70);
    samePixel(group[crossAxis], area[crossAxis]);
    samePixel(group[crossLength], area[crossLength]);
  }
}

test('docks, configures and restores a workbench with built-in and URL-installed extensions', async ({ appPage: page }) => {
  test.setTimeout(120_000);
  const editor = parts(page, 'editor');
  const groups = editor.locator('[data-group-id]');
  const sidebar = parts(page, 'sidebar');
  const panel = parts(page, 'panel');
  const activity = parts(page, 'activitybar');
  const helloWorld = activity.getByRole('button', { name: 'Hello World', exact: true });
  const greetingsIn = (part: Locator) => part.getByRole('region', { name: 'Greetings' });
  const sampleTree = (part: Locator) => greetingsIn(part).getByRole('tree');
  const sampleChild = (part: Locator) => sampleTree(part).getByRole('treeitem', { name: /Hello from Writing Room/ });
  const showSampleTree = async (part: Locator) => {
    const root = sampleTree(part).getByRole('treeitem', { name: 'Greetings', exact: true });
    await expect(root).toHaveAttribute('aria-expanded', 'false');
    await root.press('ArrowRight');
    await expect(sampleChild(part)).toBeVisible();
  };

  await test.step('Open the shell with six parts, menus, a loaded codicon and Welcome', async () => {
    for (const name of ['titlebar', 'activitybar', 'sidebar', 'editor', 'panel', 'statusbar']) {
      await expect(parts(page, name)).toBeVisible();
    }
    const menu = page.getByRole('menubar');
    await expect(menu.getByRole('menuitem', { name: 'File', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'View', exact: true })).toBeVisible();
    expect(await helloWorld.locator('[aria-hidden="true"]').evaluate(async element => {
      const faces = await document.fonts.load('24px codicon');
      const glyph = getComputedStyle(element, '::before').content.slice(1, -1).codePointAt(0) ?? 0;
      return faces.some(face => face.status === 'loaded') && glyph >= 0xe000 && glyph <= 0xf8ff;
    })).toBe(true);
    await expect(groups).toHaveCount(1);
    await expect(selected(groups)).toHaveText('Welcome');
  });

  const original = await groups.getAttribute('data-group-id');
  const originalGroup = editor.locator(`[data-group-id="${original}"]`);
  await test.step('Open two Monaco tabs from F1 and type in the second', async () => {
    for (const number of [1, 2]) {
      const input = await palette(page, 'new text');
      await expect(page.getByRole('option', { name: 'File: New Untitled Text File', exact: true })).toBeVisible();
      await input.press('Enter');
      await expect(selected(originalGroup)).toHaveText('Untitled-' + number);
      await expect(originalGroup.getByRole('textbox', { name: 'Editor content' })).toBeFocused({ timeout: 20_000 });
    }
    await page.keyboard.insertText(draft);
    await expect.poll(() => renderedText(originalGroup)).toBe(draft);
  });

  await test.step('Activate the built-in extension tree and run its view toolbar command', async () => {
    await helloWorld.click();
    await showSampleTree(sidebar);
    const extensionHosts = page.workers().filter(worker =>
      new URL(worker.url()).pathname.includes('/extensionHostWorkerMain'));
    expect(extensionHosts).toHaveLength(1);
    expect(new URL(extensionHosts[0].url()).origin).toBe(new URL(page.url()).origin);
    const status = parts(page, 'statusbar').getByRole('button', { name: 'Hello World status' });
    await expect(status).toHaveText('Hello World');
    await greetingsIn(sidebar).getByRole('button', { name: 'Say Hello' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Hello from the extension host!' })).toBeVisible();
    await page.getByRole('button', { name: 'Greet', exact: true }).click();
    await expect(status).toHaveText('Greet');
  });

  const dropPosition = 'data-editor-drop-position';
  const overlay = editor.locator(`[${dropPosition}]`);
  await test.step('Split the original group by dragging the typed tab to its right edge', async () => {
    await dragTo(page, tab(originalGroup, 'Untitled-2'), await groupPoint(originalGroup, 0.95, 0.5), overlay, dropPosition, 'right');
    await expect(groups).toHaveCount(2);
    await expect(tabNames(originalGroup)).toHaveText(['Welcome', 'Untitled-1']);
    await expect(selected(groups.last())).toHaveText('Untitled-2');
    await expect.poll(() => renderedText(groups.last())).toBe(draft);
    await expectTiled(editor, originalGroup, groups.last(), 'horizontal');
  });
  const other = await groups.last().getAttribute('data-group-id');
  const textGroup = editor.locator(`[data-group-id="${other}"]`);
  await test.step('Drag the first untitled tab into the right group', async () => {
    await dragTo(page, tab(originalGroup, 'Untitled-1'), await groupPoint(textGroup, 0.5, 0.5), overlay, dropPosition, 'center');
    await expect(groups).toHaveCount(2);
    await expect(tabNames(originalGroup)).toHaveText(['Welcome']);
    await expect(tabNames(textGroup)).toHaveCount(2);
    await expect(selected(textGroup)).toHaveText('Untitled-1');
  });
  await test.step('Dock the sole Welcome tab below the text group without adding a third group', async () => {
    const addedGroups = await editor.evaluateHandle(node => {
      const selector = '[data-group-id]';
      const initialIds = new Set(Array.from(node.querySelectorAll(selector), group => group.getAttribute('data-group-id')));
      const extra = new Set<string>();
      const collect = (records: MutationRecord[]) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added instanceof Element) {
              for (const group of [added, ...added.querySelectorAll(selector)]) {
                const id = group.getAttribute('data-group-id');
                if (id && !initialIds.has(id)) {
                  extra.add(id);
                }
              }
            }
          }
        }
      };
      const observer = new MutationObserver(collect);
      observer.observe(node, { childList: true, subtree: true });
      return () => {
        collect(observer.takeRecords());
        observer.disconnect();
        return [...extra];
      };
    });
    let extra: string[];
    try {
      await dragTo(page, tab(originalGroup, 'Welcome'), await groupPoint(textGroup, 0.5, 0.95), overlay, dropPosition, 'down');
      await expect(groups).toHaveCount(2);
      await expectTiled(editor, textGroup, originalGroup, 'vertical');
    } finally {
      extra = await addedGroups.evaluate(finish => finish());
      await addedGroups.dispose();
    }
    // Checked after the block, so a failed drag reports its own error rather than this one.
    expect(extra).toEqual([]);
    await tab(textGroup, 'Untitled-2').click();
    await expect.poll(() => renderedText(textGroup)).toBe(draft);
  });

  await test.step('Move the live extension view to the panel and hide the sidebar with its binding', async () => {
    const output = panel.getByRole('tab', { name: 'Output', exact: true });
    const target = await box(output);
    await dragTo(page, helloWorld, { x: target.x + target.width * 0.25, y: target.y + target.height / 2 },
      output, 'data-view-drop-position', 'before');
    await expect(selected(panel)).toHaveText('Hello World');
    await expect(helloWorld).toHaveCount(0);
    await expect(sampleChild(panel)).toBeVisible();

    const [before, side] = await Promise.all([box(editor), box(sidebar)]);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar).toBeHidden();
    const after = await box(editor);
    expect(after.width).toBe(before.width + side.width);
    expect(after.x + after.width).toBe(before.x + before.width);
    await expectTiled(editor, textGroup, originalGroup, 'vertical');
  });

  const origin = 'http://127.0.0.1:' + process.env.E2E_EXTENSIONS_PORT;
  const remoteCommand = /Run Remote Fixture/;
  const remote = activity.getByRole('button', { name: 'Remote Fixture', exact: true });
  const remoteRequests: string[] = [];
  page.context().on('request', request => {
    if (new URL(request.url()).origin === origin) {
      remoteRequests.push(new URL(request.url()).pathname);
    }
  });
  const prepareInstall = async () => {
    await command(page, 'Install Extension from Location', /Install Extension from Location/);
    const location = page.getByRole('textbox', { name: 'Install Extension from Location' });
    await location.fill(origin + '/remote/');
    await location.press('Enter');
    const confirm = page.getByRole('option', { name: /Install Remote Fixture/ });
    await expect(confirm).toContainText(origin);
    return confirm;
  };
  const runRemote = async () => {
    await command(page, 'Run Remote Fixture', remoteCommand);
    await expect(page.getByText('Cross-origin extension ran.', { exact: true })).toBeVisible();
    await expect(parts(page, 'statusbar').getByText('Remote fixture active')).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).click();
  };
  await test.step('Confirm the remote origin before enabling and running the extension command', async () => {
    await prepareInstall();
    expect(remoteRequests).toEqual(['/remote/package.json']);
    await expect(remote).toHaveCount(0);
    await page.getByRole('option', { name: 'Cancel', exact: true }).click();
    await palette(page, 'Run Remote Fixture');
    await expect(page.getByRole('option', { name: remoteCommand })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Checked again after the cancel, so a request sent after the confirmation appeared is not missed.
    expect(remoteRequests).toEqual(['/remote/package.json']);

    await (await prepareInstall()).click();
    await expect(remote).toBeVisible();
    await runRemote();
    expect(remoteRequests).toContain('/remote/extension.js');
  });

  const renderedDraft = textGroup.locator('.monaco-editor').getByText(draft, { exact: true });
  const settings = tab(originalGroup, 'settings.json');
  await test.step('Save editor.fontSize and resize the text already visible in the other group', async () => {
    await expect(renderedDraft).toHaveCSS('font-size', '14px');
    await tab(originalGroup, 'Welcome').click();
    await command(page, 'Open User Settings JSON', /Open User Settings \(JSON\)/);
    const input = originalGroup.getByRole('textbox', { name: 'Editor content' });
    await expect(input).toBeFocused({ timeout: 20_000 });
    await page.keyboard.press('ControlOrMeta+a');
    // Paste the whole JSON document so Monaco's typing rules cannot auto-surround the selection.
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, settingsText);
    await expect.poll(() => renderedText(originalGroup)).toBe(settingsText);
    await expect(settings).toHaveAccessibleDescription('Modified');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(settings).not.toHaveAccessibleDescription('Modified');
    await expect(renderedDraft).toHaveCSS('font-size', '24px');
  });

  await test.step('Reload and restore both groups, the already-open settings tab, and both extensions', async () => {
    const textTabs = await tabNames(textGroup).allTextContents();
    const otherTabs = await tabNames(originalGroup).allTextContents();
    const [top, bottom] = await Promise.all([box(textGroup), box(originalGroup)]);
    await page.reload();
    await expect(sidebar).toBeHidden();
    await expect(selected(panel)).toHaveText('Hello World');
    await expect(helloWorld).toHaveCount(0);
    await showSampleTree(panel);

    await expect(groups).toHaveCount(2);
    await expect(tabNames(textGroup)).toHaveText(textTabs);
    await expect(tabNames(originalGroup)).toHaveText(otherTabs);
    await expect(selected(textGroup)).toHaveText('Untitled-2');
    await expect(selected(originalGroup)).toHaveText('settings.json');
    await expect.poll(() => renderedText(originalGroup)).toBe(settingsText);
    await expect(renderedDraft).toHaveCSS('font-size', '24px');
    expect(await box(textGroup)).toEqual(top);
    expect(await box(originalGroup)).toEqual(bottom);
    await expect(remote).toBeVisible();
    await runRemote();
  });

  await test.step('Remove the extension and close every editor, then reload the empty group', async () => {
    await command(page, 'Uninstall Extension', /^Uninstall Extension/);
    await page.getByRole('option', { name: /Remote Fixture/ }).click();
    await expect(remote).toHaveCount(0);
    await expect(page.getByText('Remote fixture active')).toHaveCount(0);
    await command(page, 'Close All Editors', /Close All Editors(?! in Group)/);
    // The typed untitled tab asks before it closes (v0.2.0 promise 9); v0.1.0 closed it at once.
    await expect(page.getByRole('combobox', { name: 'Do you want to save the changes you made to Untitled-2?' })).toBeFocused();
    await page.getByRole('option', { name: /^Don't Save/ }).click();
    await expect(groups).toHaveCount(1);
    await expect(tabNames(groups)).toHaveCount(0);
    await page.reload();
    await expect(groups).toHaveCount(1);
    await expect(tabNames(groups)).toHaveCount(0);
    await expect(remote).toHaveCount(0);
    await palette(page, 'Run Remote Fixture');
    await expect(page.getByRole('option', { name: remoteCommand })).toHaveCount(0);
  });
});
