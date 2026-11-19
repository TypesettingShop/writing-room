import type { Locator, Page } from '@playwright/test';
import { box, drag, expect, renderedText, test } from './fixtures.js';

test.use({ viewport: { width: 1280, height: 800 } });

const part = (page: Page, name: string) => page.locator(`[id="workbench.parts.${name}"]`);
const groups = (page: Page) => page.locator('[data-group-id]');
const editorKey = 'writing-room:storage:1:memento/workbench.parts.editor';
const sidebarSizeKey = 'writing-room:storage:0:workbench.sideBar.size';
const selected = (scope: Locator) => scope.getByRole('tab', { selected: true });

async function newUntitled(page: Page): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New Text File', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Editor content' }).and(page.locator(':focus'))).toHaveCount(1, { timeout: 20_000 });
}

async function splitRight(page: Page): Promise<void> {
  await groups(page).first().getByRole('toolbar').getByRole('button', { name: 'Split Editor Right' }).click();
  await expect(groups(page)).toHaveCount(2);
}

async function resizeSidebar(page: Page, width: number): Promise<void> {
  const sidebar = part(page, 'sidebar');
  const start = await box(sidebar);
  await drag(page, start.x + start.width, 190, start.x + width, 190);
  expect((await box(sidebar)).width).toBe(width);
}

test('restores the first rendered layout, tab order, active tabs and shared text after reload', async ({ appPage: page }) => {
  test.setTimeout(90_000);
  await resizeSidebar(page, 235);
  const panel = part(page, 'panel');
  await panel.getByRole('tab', { name: 'Problems' }).click();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel).toBeHidden();

  await newUntitled(page);
  await page.keyboard.type('first draft');
  await newUntitled(page);
  await page.keyboard.type('shared text');
  await splitRight(page);

  const left = groups(page).first();
  const right = groups(page).last();
  const welcome = left.getByRole('tab', { name: 'Welcome' });
  const untitled = left.getByRole('tab', { name: 'Untitled-1', exact: true });
  const destination = await box(untitled);
  await welcome.dragTo(untitled, { targetPosition: { x: destination.width - 5, y: destination.height / 2 } });
  await expect(left.getByRole('tab')).toHaveText(['Untitled-1', 'Welcome', 'Untitled-2']);
  await left.getByRole('tab', { name: 'Untitled-2' }).click();
  await right.getByRole('tab', { name: 'Untitled-2' }).click();
  const ids = await groups(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-group-id')));

  // Observe the first frame with attached workbench parts, before later Monaco network work.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const sidebar = document.getElementById('workbench.parts.sidebar');
      const panel = document.getElementById('workbench.parts.panel');
      if (sidebar && panel) {
        observer.disconnect();
        requestAnimationFrame(() => {
          document.documentElement.dataset.firstLayout = JSON.stringify({
            sidebarWidth: sidebar.getBoundingClientRect().width,
            panelHidden: panel.hidden,
            groups: [...document.querySelectorAll('[data-group-id]')].map(element => element.getAttribute('data-group-id')),
          });
        });
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  const original = await Promise.all([box(part(page, 'sidebar')), box(left), box(right)]);
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-first-layout', JSON.stringify({ sidebarWidth: 235, panelHidden: true, groups: ids }));
    await expect(panel).toBeHidden();
    await expect(left.getByRole('tab')).toHaveText(['Untitled-1', 'Welcome', 'Untitled-2']);
    await expect(selected(left)).toHaveText('Untitled-2');
    await expect(selected(right)).toHaveText('Untitled-2');
    expect(await Promise.all([box(part(page, 'sidebar')), box(left), box(right)])).toEqual(original);
    await expect.poll(() => renderedText(left)).toBe('shared text');
    await expect.poll(() => renderedText(right)).toBe('shared text');
  }

  await page.keyboard.press('ControlOrMeta+j');
  await expect(selected(panel)).toHaveText('Problems');
  await newUntitled(page);
  await expect(selected(right)).toHaveText('Untitled-3');
  await left.getByRole('tab', { name: 'Untitled-1' }).click();
  await expect.poll(() => renderedText(left)).toBe('first draft');
});

test('fits a larger window’s saved proportions and part sizes into a smaller viewport', async ({ appPage: page }) => {
  await resizeSidebar(page, 420);
  await splitRight(page);
  const [left, right] = [groups(page).first(), groups(page).last()];
  const before = await box(left);
  await drag(page, before.x + before.width, 160, before.x + before.width + 90, 160);
  const ratio = (await box(left)).width / (await box(part(page, 'editor'))).width;
  expect(ratio).toBeGreaterThan(0.6);

  // Save the large window before changing the viewport, so its resize observer cannot clamp it first.
  await page.goto('about:blank');
  await page.setViewportSize({ width: 1040, height: 480 });
  await page.goto('/');
  await expect(groups(page)).toHaveCount(2);
  const [a, b, editor] = await Promise.all([box(left), box(right), box(part(page, 'editor'))]);
  expect(a.width / editor.width).toBeCloseTo(ratio, 2);
  expect(a.width).toBeGreaterThanOrEqual(220);
  expect(b.width).toBeGreaterThanOrEqual(220);
  expect(a.x + a.width).toBe(b.x);
  const panel = await box(part(page, 'panel'));
  expect(editor.y + editor.height).toBe(panel.y);
  expect(panel.height).toBeGreaterThanOrEqual(77);
  expect(panel.y + panel.height).toBe(480 - 22);

  // A much smaller launch clamps the sidebar and the split groups independently.
  await page.goto('about:blank');
  await page.setViewportSize({ width: 740, height: 340 });
  await page.goto('/');
  await expect(groups(page)).toHaveCount(2);
  expect((await box(part(page, 'sidebar'))).width).toBe(740 - 48 - 440);
  expect((await box(left)).width).toBe(220);
  expect((await box(right)).width).toBe(220);
  expect((await box(part(page, 'editor'))).height).toBeGreaterThanOrEqual(70);
});

test('uses defaults for damaged storage fields and preserves their valid neighbours', async ({ appPage: page }) => {
  await resizeSidebar(page, 240);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(part(page, 'panel')).toBeHidden();
  await page.reload();
  await expect(part(page, 'panel')).toBeHidden();

  await page.addInitScript(({ size, state }) => {
    window.localStorage.setItem(size, 'wide');
    window.localStorage.setItem(state, '{"editorpart.state":{"serializedGrid":{"root":[]}}}');
  }, { size: sidebarSizeKey, state: editorKey });
  await page.reload();
  await expect(part(page, 'panel')).toBeHidden();
  expect((await box(part(page, 'sidebar'))).width).toBe(300);
  await expect(groups(page)).toHaveCount(1);
  await expect(groups(page).getByRole('tab')).toHaveCount(0);
});

test('remembers closing all editors', async ({ appPage: page }) => {
  await expect(groups(page).getByRole('tab', { name: 'Welcome' })).toBeVisible();
  await groups(page).getByRole('button', { name: 'Close Welcome' }).click();
  await expect(groups(page).getByRole('tab')).toHaveCount(0);
  await page.reload();
  await expect(groups(page)).toHaveCount(1);
  await expect(groups(page).getByRole('tab')).toHaveCount(0);
});

test('warns on real reload when an untitled buffer exceeds the saved text budget', async ({ appPage: page }) => {
  test.setTimeout(90_000);
  await newUntitled(page);
  await page.addInitScript(({ key, encoded }) => {
    const stored = window.localStorage.getItem(key);
    if (stored) {
      const data = JSON.parse(stored);
      const editor = data['editorpart.state'].serializedGrid.root.data[0].data.editors
        .find((entry: { id: string }) => entry.id === 'workbench.editors.untitledEditorInput');
      if (editor?.value === 'Untitled-1\n') {
        editor.value += encoded;
        window.localStorage.setItem(key, JSON.stringify(data));
      }
    }
  }, { key: editorKey, encoded: Buffer.from(('x'.repeat(99) + '\n').repeat(10_000), 'utf16le').toString('base64') });
  await page.reload();
  const g = groups(page);
  await expect(selected(g)).toHaveAccessibleDescription('Modified');
  await g.locator('.monaco-editor .view-lines').first().click({ position: { x: 2, y: 8 } });
  await page.keyboard.type('z');

  const dialogPromise = page.waitForEvent('dialog', { timeout: 15_000 });
  const reload = page.reload();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.accept();
  await reload;
  await expect(selected(groups(page))).toHaveText('Welcome');
  await expect(groups(page).getByRole('tab', { name: 'Untitled-1' })).toHaveCount(0);
});

test('keeps each open tab’s state and restores the last tab to leave', async ({ appPage: first, context }) => {
  const panel = (page: Page) => part(page, 'panel');
  await panel(first).getByRole('tab', { name: 'Problems' }).click();
  await first.reload();
  await expect(selected(panel(first))).toHaveText('Problems');

  const second = await context.newPage();
  await second.goto('/');
  await expect(selected(panel(second))).toHaveText('Problems');
  await expect(selected(groups(second))).toHaveText('Welcome');

  await first.evaluate(key => {
    window.addEventListener('storage', event => {
      if (event.key === key) {
        document.documentElement.dataset.otherTabSaved = 'true';
      }
    });
  }, editorKey);
  await panel(second).getByRole('tab', { name: 'Output' }).click();
  await groups(second).getByRole('button', { name: 'Close Welcome' }).click();
  await second.goto('about:blank');
  await expect(first.locator('html')).toHaveAttribute('data-other-tab-saved', 'true');
  await expect(selected(panel(first))).toHaveText('Problems');
  await expect(selected(groups(first))).toHaveText('Welcome');

  // An unchanged first tab still writes its snapshot when it leaves, after the other tab wrote.
  await first.goto('about:blank');
  await second.goto('/');
  await expect(selected(panel(second))).toHaveText('Problems');
  await expect(selected(groups(second))).toHaveText('Welcome');
  await second.close();
});

test('starts with defaults while preserving a newer version of stored state', async ({ page }) => {
  const marker = 'writing-room:storage:version';
  await page.addInitScript(({ marker, key }) => {
    if (!window.localStorage.getItem(marker)) {
      window.localStorage.setItem(marker, '2');
      window.localStorage.setItem(key, '450');
    }
  }, { marker, key: sidebarSizeKey });

  await page.goto('/');
  await expect(selected(groups(page))).toHaveText('Welcome');
  expect((await box(part(page, 'sidebar'))).width).toBe(300);
  await resizeSidebar(page, 235);
  await page.reload();
  expect((await box(part(page, 'sidebar'))).width).toBe(300);
  expect(await page.evaluate(({ marker, key }) => [
    window.localStorage.getItem(marker), window.localStorage.getItem(key),
  ], { marker, key: sidebarSizeKey })).toEqual(['2', '450']);
});
